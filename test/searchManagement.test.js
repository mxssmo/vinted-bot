const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DeliveryStore, destinationKey, deliverPending } = require('../services/deliveryService');
const { SearchStore, validateSearchURL } = require('../services/searchStore');
const { TelegramController, startTelegramControl } = require('../services/telegramControl');
const { queueMatchingItems, normalizeListings } = require('../services/listingService');
const url = 'https://www.vinted.it/catalog?brand_ids[]=12';
const secondURL = 'https://www.vinted.it/catalog?brand_ids[]=99';
const config = { botToken: '123:fake', chatId: '456', priceLimit: 50, urls: [url, secondURL] };
const destination = destinationKey(config);
const fixture = t => {
    const store = new DeliveryStore(':memory:');
    const searches = new SearchStore(store.db);
    searches.importConfig(config);
    t.after(() => store.close());
    return { store, searches };
};
const message = (id, text, sender = 456) => ({ update_id: id, message: { message_id: id, chat: { id: 456, type: 'private' }, from: { id: sender }, text } });
const callback = (id, data, sender = 456) => ({ update_id: id, callback_query: { id: `callback-${id}`, data, from: { id: sender }, message: { message_id: 1, chat: { id: 456, type: 'private' } } } });
const items = ids => normalizeListings(ids.map(id => ({ id, title: `Shirt ${id}`, price: '10', url: `/items/${id}` })), 'it');

test('imports once, persists edits, and never resurrects deleted searches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-manager-'));
    const filename = join(directory, 'db.sqlite');
    let store = new DeliveryStore(filename);
    try {
        let searches = new SearchStore(store.db);
        searches.importConfig(config);
        const [first, second] = searches.list(destination);
        searches.change(destination, first.id, first.revision, 'delete');
        searches.change(destination, second.id, second.revision, 'replace', `${secondURL}&search_text=shirt`);
        store.close();
        store = new DeliveryStore(filename);
        searches = new SearchStore(store.db);
        searches.importConfig(config);
        assert.equal(searches.list(destination).length, 1);
        assert.ok(searches.list(destination)[0].url.includes('search_text=shirt'));
        const last = searches.list(destination)[0];
        searches.change(destination, last.id, last.revision, 'delete');
        searches.importConfig(config);
        assert.equal(searches.list(destination).length, 0);
    } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('rejects item URLs, lookalike domains, credentials and invalid input', () => {
    for (const invalid of ['bad', 'https://www.vinted.it/items/1', 'https://vinted.evil/catalog', 'https://www.vinted.it.evil/catalog', 'http://www.vinted.it/catalog', 'https://name:secret@www.vinted.it/catalog']) {
        assert.throws(() => validateSearchURL(invalid));
    }
    assert.equal(validateSearchURL('https://vinted.it/catalog?brand_ids[]=12'), url);
});

test('cross-bot edits and stale menu buttons cannot change another search', t => {
    const { searches } = fixture(t);
    const [first] = searches.list(destination);
    assert.throws(() => searches.change('999:456', first.id, first.revision, 'delete'), /outdated/);
    searches.change(destination, first.id, first.revision, 'pause');
    assert.throws(() => searches.change(destination, first.id, first.revision, 'delete'), /outdated/);
    assert.equal(searches.get(destination, first.id).enabled, 0);
});

test('Telegram add workflow saves a named URL, survives duplicate updates and isolates bots', async t => {
    const { searches } = fixture(t);
    const controller = new TelegramController(searches, [config]);
    const operations = [];
    const api = async (method, payload) => { operations.push({ method, payload }); };
    await controller.handle(message(1, '/searches'), api, '123');
    assert.ok(operations.at(-1).payload.reply_markup.inline_keyboard.flat().some(button => button.text.includes('Add')));
    await controller.handle(callback(2, 's:add'), api, '123');
    await controller.handle(message(3, 'https://www.vinted.it/catalog?search_text=shoes'), api, '123');
    await controller.handle(message(4, 'Shoes'), api, '123');
    await controller.handle(message(4, 'Shoes'), api, '123');
    assert.equal(searches.list(destination).length, 3);
    assert.equal(searches.list(destination)[2].name, 'Shoes');
    assert.ok(!operations.some(op => JSON.stringify(op).includes('Change price')));
    assert.equal(searches.list('999:456').length, 0);
});

test('unauthorized sender and wrong chat cannot add, pause, replace or delete searches', async t => {
    const { searches } = fixture(t);
    const controller = new TelegramController(searches, [config]);
    const api = async () => {};
    const [first] = searches.list(destination);
    await controller.handle(callback(1, `s:pause:${first.id}:${first.revision}`, 777), api, '123');
    await controller.handle(message(2, 'https://www.vinted.it/catalog?search_text=bad', 777), api, '123');
    const wrongChat = callback(3, `s:confirm:${first.id}:${first.revision}`);
    wrongChat.callback_query.message.chat.id = 777;
    await controller.handle(wrongChat, api, '123');
    assert.equal(searches.list(destination).length, 2);
    assert.equal(searches.get(destination, first.id).enabled, 1);
});

test('delete requires confirmation; replace preserves the other URLs and price limit', async t => {
    const { searches } = fixture(t);
    const controller = new TelegramController(searches, [config]);
    const api = async () => {};
    const [first, second] = searches.list(destination);
    await controller.handle(callback(1, `s:delete:${first.id}:${first.revision}`), api, '123');
    assert.equal(searches.list(destination).length, 2);
    await controller.handle(callback(2, `s:confirm:${first.id}:${first.revision}`), api, '123');
    assert.equal(searches.list(destination).length, 1);
    await controller.handle(callback(3, `s:replace:${second.id}:${second.revision}`), api, '123');
    await controller.handle(message(4, 'not a URL'), api, '123');
    assert.equal(searches.get(destination, second.id).url, secondURL);
    await controller.handle(message(5, `${secondURL}&search_text=coat`), api, '123');
    assert.ok(searches.get(destination, second.id).url.includes('search_text=coat'));
    assert.equal(config.priceLimit, 50);
});

test('pause prevents queueing from an in-flight scan and holds pending sends', async t => {
    const { store, searches } = fixture(t);
    const [first] = searches.list(destination);
    queueMatchingItems(items([1, 2]), url, config, store, { searches, searchEntry: first });
    searches.change(destination, first.id, first.revision, 'pause');
    queueMatchingItems(items([3]), url, config, store, { searches, searchEntry: first });
    assert.equal(store.hasItem(destination, 3), false);
    const sent = [];
    await deliverPending(store, config, async text => sent.push(text), { pause: async () => {}, canDeliver: (dest, id) => searches.canDeliver(dest, id) });
    assert.equal(sent.length, 0);
    const paused = searches.get(destination, first.id);
    const resumed = searches.change(destination, first.id, paused.revision, 'resume');
    assert.equal(searches.canDeliver(destination, 1), false);
    queueMatchingItems(items([2, 4]), url, config, store, { searches, searchEntry: resumed });
    assert.equal(searches.canDeliver(destination, 1), false);
    assert.equal(searches.canDeliver(destination, 2), true);
    assert.equal(searches.canDeliver(destination, 4), true);
});

test('overlapping active search can still deliver after original search is paused', t => {
    const { store, searches } = fixture(t);
    const [first, second] = searches.list(destination);
    queueMatchingItems(items([1]), url, config, store, { searches, searchEntry: first });
    queueMatchingItems(items([1]), secondURL, config, store, { searches, searchEntry: second });
    searches.change(destination, first.id, first.revision, 'pause');
    assert.equal(searches.canDeliver(destination, 1), true);
    searches.change(destination, second.id, second.revision, 'delete');
    assert.equal(searches.canDeliver(destination, 1), false);
});

test('pause during a delivery batch prevents remaining alerts from being sent', async t => {
    const { store, searches } = fixture(t);
    const [first] = searches.list(destination);
    queueMatchingItems(items([1, 2, 3]), url, config, store, { searches, searchEntry: first });
    let sends = 0;
    await deliverPending(store, config, async () => {
        sends++;
        searches.change(destination, first.id, first.revision, 'pause');
    }, { pause: async () => {}, canDeliver: (dest, id) => searches.canDeliver(dest, id) });
    assert.equal(sends, 1);
});

test('legacy pending items wait until rediscovered in an active search', t => {
    const { store, searches } = fixture(t);
    store.enqueue(destination, 1, { message: 'old', photos: [] });
    assert.equal(searches.canDeliver(destination, 1), false);
    const [first] = searches.list(destination);
    queueMatchingItems(items([1]), url, config, store, { searches, searchEntry: first });
    assert.equal(searches.canDeliver(destination, 1), true);
});

test('control polling groups same bot configs and never deletes an existing webhook', async t => {
    const { searches } = fixture(t);
    const methods = [];
    let factories = 0;
    const control = startTelegramControl(searches, [config, { ...config, chatId: '789' }], {
        onError: () => {},
        apiFactory: () => {
            factories++;
            return async method => { methods.push(method); return { url: 'https://existing.example/webhook' }; };
        }
    });
    await control.done;
    control.stop();
    assert.equal(factories, 1);
    assert.deepEqual(methods, ['getWebhookInfo']);
});

test('long-poll worker processes commands and stops cleanly without live requests', { timeout: 2000 }, async t => {
    const { searches } = fixture(t);
    let resolveAdded;
    const added = new Promise(resolve => { resolveAdded = resolve; });
    let polls = 0;
    const requests = [];
    const control = startTelegramControl(searches, [config], {
        onError: error => assert.fail(error),
        apiFactory: (token, { signal }) => async (method, payload) => {
            requests.push(method);
            if (method === 'getWebhookInfo') return { url: '' };
            if (method === 'getUpdates') {
                polls++;
                if (polls === 1) return [message(1, '/searches'), callback(2, 's:add'), message(3, 'https://www.vinted.it/catalog?search_text=coat'), message(4, 'Coats')];
                return new Promise((resolve, reject) => {
                    if (signal.aborted) return reject(Error('aborted'));
                    signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
                });
            }
            if (payload?.text?.startsWith('URL added.')) resolveAdded();
            return true;
        }
    });
    t.after(() => control.stop());
    await added;
    control.stop();
    await control.done;
    assert.equal(searches.list(destination).at(-1).name, 'Coats');
    assert.equal(searches.state('offset:123'), 5);
    assert.ok(requests.includes('setMyCommands'));
});

test('failed menu response cannot repeat a saved mutation; /searches restores the menu', async t => {
    const { searches } = fixture(t);
    t.mock.method(console, 'warn', () => {});
    const controller = new TelegramController(searches, [config]);
    const api = async () => {};
    await controller.handle(callback(1, 's:add'), api, '123');
    await controller.handle(message(2, 'https://www.vinted.it/catalog?search_text=coat'), api, '123');
    await controller.handle(message(3, 'Coats'), async () => { throw Error('network'); }, '123');
    await controller.handle(message(3, 'Coats'), api, '123');
    assert.equal(searches.list(destination).length, 3);
    const restored = [];
    await controller.handle(message(4, '/searches'), async (method, payload) => restored.push(payload), '123');
    assert.ok(restored[0].text.includes('(3)'));
});
