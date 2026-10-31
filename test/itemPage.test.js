const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseShippingFrom, parseItemPageDetails, getItemPageDetails, enrichItemPage } = require('../services/itemPageService');
const { VintedCooldown } = require('../services/vintedCooldown');
const { normalizeListings, queueMatchingItems, prepareAlert } = require('../services/listingService');
const { DeliveryStore, destinationKey } = require('../services/deliveryService');
const { SearchStore } = require('../services/searchStore');
const banner = value => `<div data-testid="item-shipping-banner"><span data-testid="item-shipping-banner-price">${value}</span></div>`;
const item = { id: 1, title: 'Shirt', price: { amount: 20, currency: 'EUR' }, url: 'https://www.vinted.it/items/1-shirt' };

test('reads actual shipping banner formats including zero and nonbreaking spaces', () => {
    assert.equal(parseShippingFrom(banner('da 4,39&nbsp;€')), '4,39 €');
    assert.equal(parseShippingFrom(banner('da 0,00&nbsp;€')), '0,00 €');
    assert.equal(parseShippingFrom(banner('from £2.49')), '2.49 £');
});

test('never confuses item totals, translations or missing/ambiguous amounts with shipping', () => {
    for (const html of [
        '<p>Price: €20</p><p>Total: €21.70</p>',
        '<script>{"shipping_from":"da 2,99 €"}</script>',
        banner('Calcolata al pagamento'), banner('da 3,99 € a 6,99 €'), banner('da -2,00 €'), banner('da 2,99')
    ]) assert.equal(parseShippingFrom(html), null);
});

test('successful item lookup adds the starting amount and no account-specific total', async () => {
    const details = await getItemPageDetails(item, {
        cooldown: new VintedCooldown(), catalogCooldown: new VintedCooldown(), cookieFetcher: async () => 'anonymous-test',
        fetchImpl: async (url, options) => {
            assert.equal(url, item.url);
            assert.ok(options.signal);
            return { ok: true, status: 200, text: async () => banner('da 4,39&nbsp;€') };
        }
    });
    const payload = await enrichItemPage(item, prepareAlert(item), { lookup: async () => details });
    assert.ok(payload.message.includes('🚚 Shipping from: 4,39 €'));
    assert.ok(payload.message.includes('Price: 20.00 EUR'));
    const missing = await enrichItemPage(item, prepareAlert(item), { lookup: async () => null });
    assert.ok(!missing.message.includes('Shipping'));
});

test('blocked item pages back off without blocking catalog searches or failing alerts', async () => {
    const cooldown = new VintedCooldown();
    const catalogCooldown = new VintedCooldown();
    let requests = 0;
    const options = {
        cooldown, catalogCooldown, cookieFetcher: async () => 'anonymous-test', onWarning: () => {},
        fetchImpl: async () => {
            requests++;
            return { ok: false, status: 403, headers: { get: () => null } };
        }
    };
    assert.equal(await getItemPageDetails(item, options), null);
    assert.equal(await getItemPageDetails(item, options), null);
    assert.equal(requests, 1);
    assert.doesNotThrow(() => catalogCooldown.assertReady('it'));
});

test('network failures and absent banners do not prevent alerts', async () => {
    const base = { cooldown: new VintedCooldown(), catalogCooldown: new VintedCooldown(), cookieFetcher: async () => 'anonymous-test', onWarning: () => {} };
    assert.equal(await getItemPageDetails(item, { ...base, fetchImpl: async () => { throw Error('timeout'); } }), null);
    assert.deepEqual(await getItemPageDetails(item, { ...base, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<h1>Shirt</h1>' }) }), { shipping_from: null, listed_at_label: null });
});

test('enriches only five selected unseen matches and respects a pause during lookup', async t => {
    const store = new DeliveryStore(':memory:');
    t.after(() => store.close());
    const config = { botToken: '123:test', chatId: '456', priceLimit: 30, urls: ['https://www.vinted.it/catalog'] };
    const destination = destinationKey(config);
    const searches = new SearchStore(store.db);
    searches.importConfig(config);
    const [searchEntry] = searches.list(destination);
    const items = normalizeListings(Array.from({ length: 9 }, (_, index) => ({ ...item, id: index + 1 })), 'it');
    store.enqueue(destination, 1, prepareAlert(items[0]));
    store.markDelivered(destination, 1);
    const lookedUp = [];
    await queueMatchingItems(items, config.urls[0], config, store, {
        searches, searchEntry,
        enrich: async (item, payload) => { lookedUp.push(item.id); return enrichItemPage(item, payload, { lookup: async () => ({ shipping_from: '4,39 €', listed_at_label: null }) }); }
    });
    assert.deepEqual(lookedUp, [2, 3, 4, 5, 6]);
    assert.equal(store.pending(destination).length, 5);
    assert.ok(store.pending(destination).every(alert => alert.message.includes('Shipping from: 4,39 €')));
    await queueMatchingItems(items, config.urls[0], config, store, {
        searches, searchEntry,
        enrich: async (item, payload) => {
            searches.change(destination, searchEntry.id, searchEntry.revision, 'pause');
            return payload;
        }
    });
    assert.equal(store.pending(destination).length, 5);
});

const listingAge = value => `<div data-testid="item-attributes-upload_date"><div><span>Caricato</span></div><div itemprop="upload_date"><span>${value}</span></div></div>`;

test('extracts the real listing-age value without its label or unrelated dates', () => {
    assert.deepEqual(parseItemPageDetails(`${banner('da 4,39 €')}${listingAge('2 min fa')}`), {
        shipping_from: '4,39 €', listed_at_label: '2 min fa'
    });
    assert.equal(parseItemPageDetails('<span itemprop="upload_date">unrelated</span>').listed_at_label, null);
    for (const invalid of ['', 'Unknown', '—', 'x'.repeat(121)]) {
        assert.equal(parseItemPageDetails(listingAge(invalid)).listed_at_label, null);
    }
});

test('one page request supplies both listing age and shipping to the alert', async () => {
    let calls = 0;
    const details = await getItemPageDetails(item, {
        cooldown: new VintedCooldown(), catalogCooldown: new VintedCooldown(), cookieFetcher: async () => 'anonymous-test',
        fetchImpl: async () => {
            calls++;
            return { ok: true, status: 200, text: async () => `${banner('da 4,39 €')}${listingAge('2 min fa')}` };
        }
    });
    const alert = await enrichItemPage(item, prepareAlert(item), { lookup: async () => details });
    assert.equal(calls, 1);
    assert.ok(alert.message.includes('Listed: 2 min fa'));
    assert.ok(alert.message.includes('Shipping from: 4,39 €'));
    assert.ok(!alert.message.includes('Listed: Unknown'));
});

test('listing age enriches the alert even when the shipping price is absent', async () => {
    const details = parseItemPageDetails(listingAge('3 giorni fa'));
    const alert = await enrichItemPage(item, prepareAlert(item), { lookup: async () => details });
    assert.ok(alert.message.includes('Listed: 3 giorni fa'));
    assert.ok(!alert.message.includes('Shipping from:'));
});

test('missing dates are omitted; photo timestamps are never used as listing dates', () => {
    const alert = prepareAlert({ ...item, photo: { high_resolution: { timestamp: 1793448000 } } });
    assert.ok(!alert.message.includes('Listed:'));
    const actual = prepareAlert({ ...item, created_at_ts: 1793448000 });
    assert.ok(actual.message.includes('Listed:'));
    assert.ok(!actual.message.includes('Listed: Unknown'));
});

test('listing text is escaped and missing page data still permits ordinary alerts', async () => {
    const alert = await enrichItemPage(item, prepareAlert(item), {
        lookup: async () => ({ shipping_from: null, listed_at_label: '<b>2 min fa</b>' })
    });
    assert.ok(alert.message.includes('Listed: &lt;b&gt;2 min fa&lt;/b&gt;'));
    const withoutPage = await enrichItemPage(item, prepareAlert(item), { lookup: async () => null });
    assert.ok(withoutPage.message.includes('Price: 20.00 EUR'));
    assert.ok(!withoutPage.message.includes('Listed:'));
});
