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
