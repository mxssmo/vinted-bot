const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DeliveryStore } = require('../services/deliveryService');
const { scanSearch } = require('../services/pollingService');

test('fetches only newest page and preserves filters, even with a full page', async () => {
    const items = Array.from({ length: 96 }, (_, id) => ({ id }));
    let calls = 0;
    let received;
    await scanSearch({
        url: 'https://www.vinted.it/catalog?brand_ids[]=12&brand_ids[]=99&page=20&order=price_low_to_high',
        search: async url => {
            calls++;
            const params = new URL(url).searchParams;
            assert.equal(params.get('page'), '1');
            assert.equal(params.get('order'), 'newest_first');
            assert.equal(params.get('per_page'), '96');
            assert.deepEqual(params.getAll('brand_ids[]'), ['12', '99']);
            return { items };
        },
        onItems: async batch => { received = batch; }
    });
    assert.equal(calls, 1);
    assert.deepEqual(received, items);
});

test('later cycles still fetch only page one and keep delivery deduplication', async t => {
    const store = new DeliveryStore(':memory:');
    t.after(() => store.close());
    const pages = [[3, 2, 1], [100, 99, 3]];
    let calls = 0;
    const scan = () => scanSearch({
        url: 'https://www.vinted.it/catalog', pageSize: 3,
        search: async url => {
            assert.equal(new URL(url).searchParams.get('page'), '1');
            return { items: pages[calls++].map(id => ({ id })) };
        },
        onItems: async items => {
            for (const item of items) store.enqueue('bot:chat', item.id, { message: String(item.id), photos: [] });
        }
    });
    await scan();
    store.markDelivered('bot:chat', 3);
    await scan();
    assert.equal(calls, 2);
    assert.deepEqual(store.pending('bot:chat').map(item => item.itemId), ['2', '1', '100', '99']);
});

test('failed or invalid searches never queue a partial result', async () => {
    for (const search of [
        async () => { throw Error('offline'); },
        async () => ({})
    ]) {
        await assert.rejects(scanSearch({
            url: 'https://www.vinted.it/catalog', search,
            onItems: async () => assert.fail('must not enqueue invalid results')
        }));
    }
});

test('selects at most five newest unseen matches, excluding queued and delivered items', t => {
    const { selectNewItems } = require('../services/pollingService');
    const store = new DeliveryStore(':memory:');
    t.after(() => store.close());
    const destination = 'bot:chat';
    store.enqueue(destination, 10, { message: 'delivered', photos: [] });
    store.markDelivered(destination, 10);
    store.enqueue(destination, 9, { message: 'pending', photos: [] });
    const items = [10, 9, 8, 8, 7, 6, 5, 4, 3, 2, 1].map(id => ({ id }));
    const selected = selectNewItems(items, store, destination);
    assert.deepEqual(selected.map(item => item.id), [8, 7, 6, 5, 4]);
    for (const item of selected) store.enqueue(destination, item.id, { message: String(item.id), photos: [] });
    assert.deepEqual(selectNewItems(items, store, destination).map(item => item.id), [3, 2, 1]);
    assert.equal(selectNewItems(items, store, 'other:chat').length, 5);
    assert.deepEqual(selectNewItems([], store, destination), []);
});
