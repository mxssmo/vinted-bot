const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DeliveryStore, destinationKey, deliverPending } = require('../services/deliveryService');
const config = { botToken: '123:secret', chatId: '456' };
const options = { pause: async () => {} };
const payload = { message: 'listing', photos: [] };

test('failed sends stay queued and a successful retry prevents duplicate delivery', async () => {
    const store = new DeliveryStore(':memory:');
    try {
        const key = destinationKey(config);
        store.enqueue(key, 1, payload);
        await deliverPending(store, config, async () => { throw Error('offline'); }, options);
        assert.equal(store.pending(key).length, 1);
        let sends = 0;
        const send = async () => { sends++; };
        await deliverPending(store, config, send, options);
        store.enqueue(key, 1, payload);
        await deliverPending(store, config, send, options);
        assert.equal(sends, 1);
    } finally { store.close(); }
});

test('pending messages and delivery history survive reopening the database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinted-test-'));
    const path = join(dir, 'deliveries.sqlite');
    const key = destinationKey(config);
    let store = new DeliveryStore(path);
    try {
        store.enqueue(key, 1, payload);
        store.enqueue(key, 2, payload);
        store.markDelivered(key, 1);
        store.close();
        store = new DeliveryStore(path);
        store.enqueue(key, 1, payload);
        assert.deepEqual(store.pending(key).map(x => x.itemId), ['2']);
        await deliverPending(store, config, async (message, photos) => {
            assert.equal(message, payload.message);
            assert.deepEqual(photos, []);
        }, options);
        assert.equal(store.pending(key).length, 0);
    } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('same listing can be sent to separate bots and chats; token rotation preserves identity', async () => {
    const store = new DeliveryStore(':memory:');
    try {
        const configs = [config, { ...config, chatId: '789' }, { ...config, botToken: '999:secret' }];
        for (const target of configs) store.enqueue(destinationKey(target), 1, payload);
        const calls = [];
        for (const target of configs) await deliverPending(store, target, async () => calls.push(destinationKey(target)), options);
        assert.equal(new Set(calls).size, 3);
        assert.equal(destinationKey({ ...config, botToken: '123:rotated' }), destinationKey(config));
    } finally { store.close(); }
});

test('listing HTML is escaped', () => {
    const { formatMessage } = require('../utils/mssgFormat');
    const message = formatMessage({ title: 'A & <B>', size_title: '<M>', color_title: '"Black"', status: '<New>' }, 10, 'now');
    assert.ok(message.includes('A &amp; &lt;B&gt;'));
    assert.ok(message.includes('&lt;M&gt;'));
    assert.ok(message.includes('&quot;'));
    assert.ok(message.includes('&lt;New&gt;'));
});

test('queued listing keeps its Vinted button URL through storage and delivery', async t => {
    const store = new DeliveryStore(':memory:');
    t.after(() => store.close());
    const { prepareAlert } = require('../services/listingService');
    const { sendMessageToTelegram } = require('../services/telegramService');
    const itemUrl = 'https://www.vinted.it/items/123-shirt';
    store.enqueue(destinationKey(config), 123, prepareAlert({ title: 'Shirt', price: 4, url: itemUrl }));
    let calls = 0;
    await deliverPending(store, config, (message, photos, target, sendOptions) => sendMessageToTelegram(message, photos, target, {
        ...sendOptions,
        fetchImpl: async (_, request) => {
            calls++;
            const body = JSON.parse(request.body);
            assert.equal(body.reply_markup.inline_keyboard[0][0].url, itemUrl);
            return { ok: true, json: async () => ({ ok: true }) };
        }
    }), options);
    assert.equal(calls, 1);
    assert.equal(store.pending(destinationKey(config)).length, 0);
});

test('permanently rejected item is isolated and the next alert is delivered', async () => {
    const store = new DeliveryStore(':memory:');
    try {
        const key = destinationKey(config);
        store.enqueue(key, 1, payload);
        store.enqueue(key, 2, { ...payload, message: 'valid' });
        const sent = [];
        await deliverPending(store, config, async message => {
            if (message === payload.message) throw Object.assign(Error('invalid'), { permanent: true });
            sent.push(message);
        }, options);
        assert.deepEqual(sent, ['valid']);
        assert.equal(store.pending(key).length, 0);
        assert.equal(store.hasItem(key, 1), true);
        assert.ok(store.db.prepare('SELECT failed_at FROM deliveries WHERE item_id = ?').get('1').failed_at);
    } finally { store.close(); }
});

test('temporary item failure remains pending while later alerts proceed', async () => {
    const store = new DeliveryStore(':memory:');
    try {
        const key = destinationKey(config);
        store.enqueue(key, 1, payload);
        store.enqueue(key, 2, { ...payload, message: 'valid' });
        const sent = [];
        await deliverPending(store, config, async message => {
            if (message === payload.message) throw Error('offline');
            sent.push(message);
        }, options);
        assert.deepEqual(sent, ['valid']);
        assert.deepEqual(store.pending(key).map(row => row.itemId), ['1']);
    } finally { store.close(); }
});

test('destination rate limit survives restart and retains all queued alerts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinted-cooldown-'));
    const path = join(dir, 'deliveries.sqlite');
    let store = new DeliveryStore(path);
    try {
        const key = destinationKey(config);
        store.enqueue(key, 1, payload);
        store.enqueue(key, 2, payload);
        let calls = 0;
        await deliverPending(store, config, async () => {
            calls++;
            throw Object.assign(Error('rate limit'), { destinationFailure: true, retryAfter: 600 });
        }, options);
        assert.equal(calls, 1);
        store.close();
        store = new DeliveryStore(path);
        await deliverPending(store, config, async () => { calls++; }, options);
        assert.equal(calls, 1);
        assert.equal(store.pending(key).length, 2);
        store.defer(key, -1);
        await deliverPending(store, config, async () => { calls++; }, options);
        assert.equal(calls, 3);
        assert.equal(store.pending(key).length, 0);
    } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('existing database migrates without losing queued or delivered history', () => {
    const { DatabaseSync } = require('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'vinted-migrate-'));
    const path = join(dir, 'deliveries.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE deliveries (destination TEXT NOT NULL, item_id TEXT NOT NULL, payload TEXT NOT NULL, delivered_at INTEGER, PRIMARY KEY(destination, item_id))`);
    legacy.prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?)').run('123:456', '1', JSON.stringify(payload), null);
    legacy.prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?)').run('123:456', '2', JSON.stringify(payload), 1);
    legacy.close();
    const store = new DeliveryStore(path);
    try {
        assert.deepEqual(store.pending('123:456').map(row => row.itemId), ['1']);
        assert.equal(store.hasItem('123:456', 2), true);
        store.enqueue('123:456', 3, payload);
        assert.equal(store.pending('123:456').length, 2);
    } finally { store.close(); rmSync(dir, { recursive: true }); }
});
