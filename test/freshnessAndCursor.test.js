const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DeliveryStore, destinationKey, deliverPending } = require('../services/deliveryService');
const { SearchStore } = require('../services/searchStore');
const { normalizeListings, queueMatchingItems } = require('../services/listingService');
const { scanSearch } = require('../services/pollingService');
const { TelegramCursor, REBASE_AFTER } = require('../services/telegramCursor');
const { TelegramController, startTelegramControl } = require('../services/telegramControl');
const url = 'https://www.vinted.it/catalog';
const config = { botToken: '123:fake', chatId: '456', urls: [url], priceLimit: 50 };
const destination = destinationKey(config);
const items = ids => normalizeListings(ids.map(id => ({ id, title: `Item ${id}`, price: 10, url: `/items/${id}` })), 'it');
const message = (id, text) => ({ update_id: id, message: { message_id: id, from: { id: 456 }, chat: { id: 456 }, text } });
const fixture = t => {
    const store = new DeliveryStore(':memory:');
    const searches = new SearchStore(store.db);
    searches.importConfig(config);
    t.after(() => store.close());
    return { store, searches, entry: searches.list(destination)[0] };
};

test('restart holds all previous pending alerts until a fresh page confirms them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fresh-alerts-'));
    const filename = join(directory, 'deliveries.sqlite');
    let store = new DeliveryStore(filename);
    try {
        let searches = new SearchStore(store.db);
        searches.importConfig(config);
        let [entry] = searches.list(destination);
        queueMatchingItems(items([1, 2, 3]), url, config, store, { searches, searchEntry: entry });
        store.markDelivered(destination, 1);
        store.close();
        store = new DeliveryStore(filename);
        searches = new SearchStore(store.db);
        [entry] = searches.list(destination);
        const sent = [];
        const deliver = () => deliverPending(store, config, async text => sent.push(text), {
            pause: async () => {}, canDeliver: (dest, id) => searches.canDeliver(dest, id)
        });
        await deliver();
        assert.equal(sent.length, 0);
        queueMatchingItems(items([3, 4]), url, config, store, { searches, searchEntry: entry });
        await deliver();
        assert.equal(sent.length, 2);
        assert.ok(sent.some(text => text.includes('Item 3')));
        assert.ok(sent.some(text => text.includes('Item 4')));
        assert.ok(!sent.some(text => text.includes('Item 2')));
        assert.deepEqual(store.pending(destination).map(row => row.itemId), ['2']);
        assert.equal(store.hasItem(destination, 1), true);
    } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('failed fetch or disappearance from a later page check cannot release old matches', async t => {
    const { store, searches, entry } = fixture(t);
    queueMatchingItems(items([1, 2]), url, config, store, { searches, searchEntry: entry });
    assert.equal(searches.canDeliver(destination, 1), true);
    searches.beginCycle();
    await assert.rejects(scanSearch({ url,
        search: async () => { throw Error('Vinted unavailable'); },
        onItems: async batch => queueMatchingItems(batch, url, config, store, { searches, searchEntry: entry })
    }));
    assert.equal(searches.canDeliver(destination, 1), false);
    queueMatchingItems(items([2, 3]), url, config, store, { searches, searchEntry: entry });
    assert.equal(searches.canDeliver(destination, 1), false);
    assert.equal(searches.canDeliver(destination, 2), true);
    assert.equal(searches.canDeliver(destination, 3), true);
});

test('recent Telegram cursor keeps duplicate protection; idle cursor accepts lower fresh IDs', async t => {
    const { searches } = fixture(t);
    const now = Date.parse('2026-10-31T12:00:00Z');
    searches.state('offset:123', 90000);
    searches.state('last-update-at:123', now - 60000);
    const cursor = new TelegramCursor(searches, '123', () => now);
    assert.equal(cursor.pollOffset(), 90000);
    searches.state('last-update-at:123', now - 8 * 86400000);
    searches.state('session:123:456:456', { mode: 'add_name' });
    searches.state('session:999:456:456', { mode: 'add_name' });
    assert.equal(cursor.pollOffset(), 0);
    assert.equal(searches.state('session:123:456:456'), null);
    assert.notEqual(searches.state('session:999:456:456'), null);
    const controller = new TelegramController(searches, [config], { now: () => now });
    const replies = [];
    await controller.handle(message(7, '/searches'), async (method, payload) => replies.push(payload), '123');
    await controller.handle(message(7, '/searches'), async (method, payload) => replies.push(payload), '123');
    assert.equal(replies.length, 1);
    assert.equal(searches.state('offset:123'), 8);
    assert.equal(cursor.pollOffset(), 8);
});

test('upgrade recovery reopens menus without replaying old add operations', async t => {
    const { searches } = fixture(t);
    searches.state('offset:123', 1000);
    searches.state('session:123:456:456', { mode: 'add_name', url: `${url}?search_text=old`, expires: Date.now() + 60000 });
    const cursor = new TelegramCursor(searches, '123');
    assert.equal(cursor.pollOffset(), 0);
    assert.equal(cursor.legacyFloor, 1000);
    const controller = new TelegramController(searches, [config]);
    const operations = [];
    const api = async (method, payload) => operations.push({ method, payload });
    await controller.handle({ update_id: 10, callback_query: { id: 'old-add', from: { id: 456 }, message: { message_id: 1, chat: { id: 456 } }, data: 's:add' } }, api, '123', { silentRecovery: true });
    await controller.handle(message(11, `${url}?search_text=old`), api, '123', { silentRecovery: true });
    await controller.handle(message(12, 'Old replayed search'), api, '123');
    cursor.finishBatch();
    assert.equal(operations.length, 1);
    assert.ok(operations[0].payload.text.startsWith('Your searches'));
    assert.equal(searches.list(destination).length, 1);
    await controller.handle(message(13, `${url}?search_text=new`), api, '123');
    await controller.handle(message(14, 'New search'), api, '123');
    assert.equal(searches.list(destination).length, 2);
});

test('an interrupted legacy recovery retains its replay guard on restart', async t => {
    const { searches } = fixture(t);
    searches.state('offset:123', 1000);
    let cursor = new TelegramCursor(searches, '123');
    cursor.pollOffset();
    const controller = new TelegramController(searches, [config]);
    await controller.handle(message(10, '/searches'), async () => {}, '123');
    cursor = new TelegramCursor(searches, '123');
    assert.equal(cursor.pollOffset(), 11);
    assert.equal(cursor.legacyFloor, 1000);
    const [entry] = searches.list(destination);
    await controller.handle({ update_id: 11, callback_query: { id: 'old-delete', from: { id: 456 }, message: { message_id: 1, chat: { id: 456 } }, data: `s:confirm:${entry.id}:${entry.revision}` } }, async () => {}, '123');
    assert.equal(searches.list(destination).length, 1);
    cursor.finishBatch();
    assert.equal(cursor.legacyFloor, null);
});

test('worker polls from zero after long inactivity and responds to a lower update ID', { timeout: 2000 }, async t => {
    const { searches } = fixture(t);
    const now = Date.parse('2026-10-31T12:00:00Z');
    searches.state('offset:123', 90000);
    searches.state('last-update-at:123', now - REBASE_AFTER - 1000);
    let resolveReply;
    const reply = new Promise(resolve => { resolveReply = resolve; });
    let polls = 0;
    const control = startTelegramControl(searches, [config], {
        now: () => now, onError: error => assert.fail(error),
        apiFactory: (token, { signal }) => async (method, payload) => {
            if (method === 'getWebhookInfo') return { url: '' };
            if (method === 'getUpdates') {
                if (polls++ === 0) {
                    assert.equal(payload.offset, 0);
                    return [message(7, '/searches')];
                }
                assert.equal(payload.offset, 8);
                return new Promise((resolve, reject) => {
                    if (signal.aborted) return reject(Error('stopped'));
                    signal.addEventListener('abort', () => reject(Error('stopped')), { once: true });
                });
            }
            if (method === 'sendMessage' && payload.text.startsWith('Your searches')) resolveReply();
            return true;
        }
    });
    t.after(() => control.stop());
    await reply;
    control.stop();
    await control.done;
    assert.equal(searches.state('offset:123'), 8);
});

test('legacy worker batches recover one menu without replaying edits, then accept new input', { timeout: 2000 }, async t => {
    const { searches } = fixture(t);
    searches.state('offset:123', 1000);
    let resolveAdded;
    const added = new Promise(resolve => { resolveAdded = resolve; });
    let polls = 0;
    let recoveredMenus = 0;
    const control = startTelegramControl(searches, [config], {
        onError: error => assert.fail(error),
        apiFactory: (token, { signal }) => async (method, payload) => {
            if (method === 'getWebhookInfo') return { url: '' };
            if (method === 'getUpdates') {
                polls++;
                if (polls === 1) {
                    assert.equal(payload.offset, 0);
                    return [
                        { update_id: 10, callback_query: { id: 'old', from: { id: 456 }, message: { message_id: 1, chat: { id: 456 } }, data: 's:add' } },
                        message(11, `${url}?search_text=old`), message(12, 'Old search')
                    ];
                }
                if (polls === 2) {
                    assert.equal(payload.offset, 13);
                    assert.equal(searches.list(destination).length, 1);
                    return [message(13, `${url}?search_text=new`), message(14, 'New search')];
                }
                return new Promise((resolve, reject) => {
                    if (signal.aborted) return reject(Error('stopped'));
                    signal.addEventListener('abort', () => reject(Error('stopped')), { once: true });
                });
            }
            if (payload?.text?.startsWith('Your searches')) recoveredMenus++;
            if (payload?.text?.startsWith('URL added.')) resolveAdded();
            return true;
        }
    });
    t.after(() => control.stop());
    await added;
    control.stop();
    await control.done;
    assert.equal(recoveredMenus, 1);
    assert.equal(searches.list(destination).length, 2);
    assert.equal(searches.list(destination)[1].name, 'New search');
});
