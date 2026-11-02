const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeListings, prepareAlert, queueMatchingItems } = require('../services/listingService');
const { DeliveryStore, destinationKey } = require('../services/deliveryService');
const { scanSearch } = require('../services/pollingService');
const { search } = require('../services/vintedService');
const { VintedCooldown } = require('../services/vintedCooldown');
const config = { botToken: '123:test', chatId: '456', priceLimit: 50 };
const url = 'https://www.vinted.it/catalog';
const listing = id => ({ id, title: `Shirt ${id}`, price: { amount: '12.50', currency_code: 'EUR' }, url: `/items/${id}-shirt` });

test('mixed response retains valid listings around invalid records', () => {
    const warnings = [];
    const items = normalizeListings([
        listing(10), null, {}, { ...listing(9), url: 'http://[' },
        { ...listing(8), title: null }, { ...listing(7), price: null },
        { ...listing(6), price: { amount: '12oops' } },
        { ...listing(5), price: { amount: -1 } },
        { ...listing(4), url: 'https://example.com/items/4' }, listing(3)
    ], 'it', warning => warnings.push(warning));
    assert.deepEqual(items.map(item => item.id), [10, 3]);
    assert.equal(warnings.length, 8);
    assert.equal(items[0].price.amount, 12.5);
    assert.equal(items[0].price.currency, 'EUR');
    assert.equal(items[0].url, 'https://www.vinted.it/items/10-shirt');
});

test('missing URL is recoverable and malformed optional fields do not fail formatting', () => {
    const [item] = normalizeListings([{
        ...listing(1), url: undefined, item_box: { second_line: 42 },
        size_title: {}, status: {}, created_at_ts: 'bad',
        photos: 'bad', photo: { url: 'https://images.example/cover.jpg', variants: {} }
    }], 'it');
    assert.equal(item.url, 'https://www.vinted.it/items/1');
    const alert = prepareAlert(item);
    assert.ok(!alert.message.includes('Listed:'));
    assert.ok(!alert.message.includes('Unknown'));
    assert.deepEqual(alert.photos, ['https://images.example/cover.jpg']);
    assert.deepEqual(prepareAlert({ ...item, photos: [null, {}, { url: 'javascript:bad' }] }).photos, []);
});

test('scan skips invalid IDs without discarding other results', async t => {
    t.mock.method(console, 'warn', () => {});
    let received;
    await scanSearch({ url, search: async () => ({ items: [null, {}, { id: {} }, listing(1)] }), onItems: async items => { received = items; } });
    assert.deepEqual(received.map(item => item.id), [1]);
});

test('bad alert preparation does not consume a slot or prevent the next five valid alerts', t => {
    const store = new DeliveryStore(':memory:');
    t.after(() => store.close());
    const items = normalizeListings(Array.from({ length: 7 }, (_, i) => listing(10 - i)), 'it');
    const warnings = [];
    queueMatchingItems(items, url, config, store, {
        onWarning: warning => warnings.push(warning),
        prepare: item => {
            if (item.id === 10) throw Error('malformed');
            return prepareAlert(item);
        }
    });
    assert.equal(warnings.length, 1);
    assert.deepEqual(store.pending(destinationKey(config)).map(item => item.itemId), ['5', '6', '7', '8', '9']);
});

test('storage errors propagate instead of silently dropping alerts', () => {
    assert.throws(() => queueMatchingItems(normalizeListings([listing(1)], 'it'), url, config, {
        hasItem: () => false,
        enqueue: () => { throw Error('disk full'); }
    }), /disk full/);
});

test('catalog normalization never refetches a successful response because of one bad listing', async t => {
    for (const method of ['log', 'warn']) t.mock.method(console, method, () => {});
    let calls = 0;
    const result = await search(url, 3, {
        cooldown: new VintedCooldown(), cookieFetcher: async () => 'test', wait: async () => {},
        fetchImpl: async () => {
            calls++;
            return { status: 200, ok: true, headers: { get: () => 'application/json' },
                json: async () => ({ items: [listing(3), { ...listing(2), url: 'https://[' }, listing(1)] }) };
        }
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.items.map(item => item.id), [3, 1]);
});
