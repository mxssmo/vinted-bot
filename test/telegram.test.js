const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendMessageToTelegram } = require('../services/telegramService');
const config = { botToken: '123:fake', chatId: '456' };
const response = (status, data) => ({ ok: status === 200, status, json: async () => data });

for (const [photos, method] of [[[], 'sendMessage'], [['a'], 'sendPhoto'], [['a', 'b'], 'sendMediaGroup']]) {
    test(`uses ${method} for ${photos.length} photos`, async () => {
        let calls = 0;
        await sendMessageToTelegram('listing', photos, config, { fetchImpl: async (url, options) => {
            calls++;
            assert.ok(url.endsWith(`/${method}`));
            const payload = JSON.parse(options.body);
            assert.equal(payload.chat_id, '456');
            if (method === 'sendMediaGroup') {
                assert.equal(payload.media.length, 2);
                assert.equal(payload.media[0].caption, 'listing');
                assert.equal(payload.media[1].caption, undefined);
            } else assert.equal(payload.caption || payload.text, 'listing');
            return response(200, { ok: true });
        } });
        assert.equal(calls, 1);
    });
}

test('explicit photo rejection falls back to a single text alert', async () => {
    const methods = [];
    await sendMessageToTelegram('listing', ['broken'], config, { fetchImpl: async url => {
        methods.push(url.split('/').pop());
        return methods.length === 1
            ? response(400, { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' })
            : response(200, { ok: true });
    } });
    assert.deepEqual(methods, ['sendPhoto', 'sendMessage']);
});

for (const status of [401, 403, 429, 500]) {
    test(`status ${status} does not trigger a text fallback`, async () => {
        let calls = 0;
        await assert.rejects(sendMessageToTelegram('listing', ['a'], config, { fetchImpl: async () => {
            calls++;
            return response(status, { ok: false, error_code: status, parameters: { retry_after: 60 } });
        } }), error => error.status === status && !error.permanent);
        assert.equal(calls, 1);
    });
}

test('network timeout does not send an immediate duplicate via text', async () => {
    let calls = 0;
    await assert.rejects(sendMessageToTelegram('listing', ['a'], config, { fetchImpl: async () => {
        calls++;
        throw Error('timeout');
    } }), /timeout/);
    assert.equal(calls, 1);
});

test('bad chat is treated as destination failure, not a bad listing', async () => {
    await assert.rejects(sendMessageToTelegram('listing', [], config, { fetchImpl: async () =>
        response(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })
    }), error => error.destinationFailure && !error.permanent);
});

for (const photos of [[], ['photo'], ['broken']]) {
    test(`listing button survives ${photos[0] === 'broken' ? 'photo rejection' : photos.length ? 'photo delivery' : 'text delivery'}`, async () => {
        let calls = 0;
        await sendMessageToTelegram('<b>Shirt</b>', photos, config, {
            itemUrl: 'https://www.vinted.it/items/123-shirt',
            fetchImpl: async (_, options) => {
                calls++;
                const body = JSON.parse(options.body);
                assert.deepEqual(body.reply_markup.inline_keyboard, [[{ text: 'Open on Vinted ↗', url: 'https://www.vinted.it/items/123-shirt' }]]);
                return photos[0] === 'broken' && calls === 1
                    ? response(400, { ok: false, error_code: 400 }) : response(200, { ok: true });
            }
        });
        assert.equal(calls, photos[0] === 'broken' ? 2 : 1);
    });
}

test('album retains one caption link without an extra message or unsupported keyboard', async () => {
    let calls = 0;
    await sendMessageToTelegram('<b>Shirt</b>', ['a', 'b'], config, {
        itemUrl: 'https://www.vinted.it/items/123-shirt?x=1&y=2',
        fetchImpl: async (url, options) => {
            calls++;
            assert.ok(url.endsWith('/sendMediaGroup'));
            const body = JSON.parse(options.body);
            assert.equal(body.reply_markup, undefined);
            assert.ok(body.media[0].caption.includes('href="https://www.vinted.it/items/123-shirt?x=1&amp;y=2"'));
            return response(200, { ok: true });
        }
    });
    assert.equal(calls, 1);
});

test('long attribute lists use one complete text alert rather than an oversized photo caption', async () => {
    const message = `<b>Shirt</b>\nMateriale: ${'cotone '.repeat(200)}`;
    let calls = 0;
    await sendMessageToTelegram(message, ['photo'], config, {
        itemUrl: 'https://www.vinted.it/items/123-shirt',
        fetchImpl: async (url, options) => {
            calls++;
            assert.ok(url.endsWith('/sendMessage'));
            const body = JSON.parse(options.body);
            assert.equal(body.text, message);
            assert.ok(body.reply_markup);
            return response(200, { ok: true });
        }
    });
    assert.equal(calls, 1);
});

test('very long attributes are split without losing values or breaking emoji and HTML entities', async () => {
    const text = `Shirt\nMateriale: ${'🧵 & cotone '.repeat(900)}`;
    const message = `<b>${text.replace(/&/g, '&amp;')}</b>`;
    const chunks = [];
    await sendMessageToTelegram(message, ['photo'], config, {
        itemUrl: 'https://www.vinted.it/items/123-shirt',
        fetchImpl: async (url, options) => {
            assert.ok(url.endsWith('/sendMessage'));
            const body = JSON.parse(options.body);
            assert.ok(body.text.length > 0 && body.text.length <= 4096);
            assert.equal(body.parse_mode, undefined);
            assert.ok(!/[\uD800-\uDBFF]$/.test(body.text));
            chunks.push(body);
            return response(200, { ok: true });
        }
    });
    assert.equal(chunks.map(chunk => chunk.text).join(''), text);
    assert.ok(chunks.at(-1).reply_markup);
    assert.ok(chunks.slice(0, -1).every(chunk => !chunk.reply_markup));
});
