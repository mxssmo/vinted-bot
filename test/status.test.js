const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DeliveryStore, destinationKey } = require('../services/deliveryService');
const { SearchStore } = require('../services/searchStore');
const { BotStatus, formatTime } = require('../services/statusService');
const { VintedCooldown } = require('../services/vintedCooldown');
const { TelegramController } = require('../services/telegramControl');
const config = { botToken: '123:fake', chatId: '456', urls: ['https://www.vinted.it/catalog', 'https://www.vinted.fr/catalog'], priceLimit: 50 };
const fixture = t => {
    const store = new DeliveryStore(':memory:');
    const searches = new SearchStore(store.db);
    searches.importConfig(config);
    t.after(() => store.close());
    return { store, searches, destination: destinationKey(config) };
};

test('status separates pending eligible/held alerts, failures and paused searches', t => {
    const { store, searches, destination } = fixture(t);
    const [active, paused] = searches.list(destination);
    searches.change(destination, paused.id, paused.revision, 'pause');
    for (const id of [1, 2, 3]) store.enqueue(destination, id, { message: 'item', photos: [] });
    searches.link(destination, 1, active);
    searches.recordCurrentMatches(destination, active, [1]);
    searches.link(destination, 2, paused);
    store.markFailed(destination, 3);
    const status = new BotStatus(store, searches);
    const text = status.view(config).text;
    assert.ok(text.includes('1 active · 1 paused'));
    assert.ok(text.includes('Alerts queued: 1 eligible · 1 held'));
    assert.ok(text.includes('Failed alerts: 1'));
    assert.ok(text.includes('Not yet recorded'));
});

test('status persists last success through failures and ignores replaced/deleted URL health', t => {
    const { store, searches, destination } = fixture(t);
    let now = Date.parse('2026-10-31T10:00:00Z');
    const status = new BotStatus(store, searches, { now: () => now });
    const [first] = searches.list(destination);
    status.record(config, first);
    const successfulAt = now;
    now += 60000;
    status.record(config, first, Error('private error text'));
    let text = status.view(config).text;
    assert.ok(text.includes(`Last successful check: ${formatTime(successfulAt)}`));
    assert.ok(text.includes('Recent search errors: 1'));
    assert.ok(!text.includes('private error text'));
    const restarted = new BotStatus(store, searches, { now: () => now });
    assert.equal(restarted.view(config).text, text);
    searches.change(destination, first.id, first.revision, 'replace', 'https://www.vinted.it/catalog?search_text=coat');
    text = restarted.view(config).text;
    assert.ok(text.includes('Last successful check: Not yet recorded'));
    assert.ok(text.includes('Recent search errors: 0'));
});

test('reports cooldowns and backup failure while preserving last backup success', t => {
    const { store, searches } = fixture(t);
    const now = Date.parse('2026-10-31T10:00:00Z');
    const cooldown = new VintedCooldown(() => now);
    assert.throws(() => cooldown.block('it', 1800000));
    store.db.prepare('INSERT INTO destination_retries VALUES (?, ?)').run(destinationKey(config), now + 600000);
    const backups = { lastSuccess: now - 86400000, lastError: now };
    const status = new BotStatus(store, searches, { now: () => now, cooldown, backups });
    const text = status.view(config).text;
    assert.ok(text.includes(`it until ${formatTime(now + 1800000)}`));
    assert.ok(text.includes('Telegram cooldown: until'));
    assert.ok(text.includes(`Last backup: ${formatTime(backups.lastSuccess)}`));
    assert.ok(text.includes('Backup warning: last attempt failed'));
});

test('/status and refresh use the authenticated bot context without cancelling input', async t => {
    const { store, searches, destination } = fixture(t);
    const status = new BotStatus(store, searches);
    const controller = new TelegramController(searches, [config], { statusProvider: candidate => status.view(candidate) });
    searches.state(`session:${destination}:456`, { mode: 'add_url', expires: Date.now() + 60000 });
    const updates = [
        { update_id: 1, message: { chat: { id: 456 }, from: { id: 456 }, text: '/status' } },
        { update_id: 2, callback_query: { id: 'cb', from: { id: 456 }, message: { chat: { id: 456 }, message_id: 3 }, data: 's:status' } }
    ];
    const calls = [];
    for (const update of updates) await controller.handle(update, async (method, payload) => calls.push({ method, payload }), '123');
    assert.equal(calls.filter(call => call.payload.text?.startsWith('Bot status')).length, 2);
    assert.ok(calls.some(call => call.method === 'editMessageText'));
    assert.equal(searches.state(`session:${destination}:456`).mode, 'add_url');
    const count = calls.length;
    await controller.handle({ update_id: 3, message: { chat: { id: 456 }, from: { id: 999 }, text: '/status' } }, async (method, payload) => calls.push({ method, payload }), '123');
    assert.equal(calls.length, count);
});
