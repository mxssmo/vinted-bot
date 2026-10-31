const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VintedCooldown, BLOCK_DELAY } = require('../services/vintedCooldown');
const { search } = require('../services/vintedService');
const { fetchCookie, cookies } = require('../services/cookieService');
const url = 'https://www.vinted.it/catalog';
const response = (status, retryAfter = null) => ({
    status, ok: status === 200,
    headers: { get: key => key === 'retry-after' ? retryAfter : 'application/json', raw: () => ({ 'set-cookie': ['access_token_web=test; Max-Age=3600'] }) },
    json: async () => ({ items: [] })
});
const quiet = t => {
    for (const method of ['log', 'error', 'warn']) t.mock.method(console, method, () => {});
};

for (const [header, milliseconds] of [['120', 120000], ['bad', 180000], [null, 180000], ['-2', 180000]]) {
    test(`429 cooldown handles Retry-After ${header}`, () => {
        let now = Date.parse('2026-10-30T12:00:00Z');
        const cooldown = new VintedCooldown(() => now);
        assert.throws(() => cooldown.checkResponse('it', response(429, header)), { code: 'VINTED_COOLDOWN' });
        now += milliseconds - 1;
        assert.throws(() => cooldown.assertReady('it'));
        now++;
        assert.doesNotThrow(() => cooldown.assertReady('it'));
    });
}

test('Retry-After HTTP dates are respected and blocks do not shorten longer pauses', () => {
    let now = Date.parse('2026-10-30T12:00:00Z');
    const cooldown = new VintedCooldown(() => now);
    assert.throws(() => cooldown.checkResponse('it', response(429, new Date(now + 7200000).toUTCString())));
    assert.throws(() => cooldown.checkResponse('it', response(403)));
    now += BLOCK_DELAY;
    assert.throws(() => cooldown.assertReady('it'));
    assert.doesNotThrow(() => cooldown.assertReady('fr'));
    now += 7200000;
    assert.doesNotThrow(() => cooldown.assertReady('it'));
});

test('catalog 403 stops retries and suppresses subsequent catalog and cookie requests', async t => {
    quiet(t);
    let now = 1000;
    const cooldown = new VintedCooldown(() => now);
    let requests = 0;
    let cookieCalls = 0;
    const options = {
        cooldown, wait: async () => {},
        cookieFetcher: async () => { cookieCalls++; return 'test'; },
        fetchImpl: async () => { requests++; return response(403); }
    };
    await assert.rejects(search(url, 3, options), { code: 'VINTED_COOLDOWN' });
    await assert.rejects(search(url, 3, options), { code: 'VINTED_COOLDOWN' });
    await assert.rejects(fetchCookie('it', { cooldown, fetchImpl: async () => assert.fail('must not request cookies') }), { code: 'VINTED_COOLDOWN' });
    assert.equal(requests, 1);
    assert.equal(cookieCalls, 1);
    now += BLOCK_DELAY;
    await search(url, 3, { ...options, fetchImpl: async () => response(200) });
});

test('homepage 429 shares cooldown with catalog searches and resumes when due', async t => {
    quiet(t);
    let now = 1000;
    const cooldown = new VintedCooldown(() => now);
    cookies.delete('it');
    await assert.rejects(fetchCookie('it', { cooldown, wait: async () => {}, fetchImpl: async () => response(429, '600') }), { code: 'VINTED_COOLDOWN' });
    await assert.rejects(search(url, 3, { cooldown, cookieFetcher: async () => assert.fail('must not refresh') }), { code: 'VINTED_COOLDOWN' });
    now += 600000;
    assert.equal(await fetchCookie('it', { cooldown, wait: async () => {}, fetchImpl: async () => response(200) }), 'test');
    cookies.delete('it');
});

test('catalog 429 does not sleep through retries or invalidate the cookie', async t => {
    quiet(t);
    const cooldown = new VintedCooldown(() => 1000);
    cookies.set('it', 'test');
    let requests = 0;
    await assert.rejects(search(url, 3, {
        cooldown, wait: async () => {}, cookieFetcher: async () => 'test',
        fetchImpl: async () => { requests++; return response(429, '600'); }
    }), { code: 'VINTED_COOLDOWN' });
    assert.equal(requests, 1);
    assert.equal(cookies.get('it'), 'test');
    cookies.delete('it');
});

test('expired authentication refreshes once; repeated 401 enters cooldown', async t => {
    quiet(t);
    let requests = 0;
    const cooldown = new VintedCooldown(() => 1000);
    const options = {
        cooldown, wait: async () => {}, cookieFetcher: async () => 'test',
        fetchImpl: async () => { requests++; return response(401); }
    };
    await assert.rejects(search(url, 3, options), { code: 'VINTED_COOLDOWN' });
    assert.equal(requests, 2);
    await assert.rejects(search(url, 3, options), { code: 'VINTED_COOLDOWN' });
    assert.equal(requests, 2);
    requests = 0;
    await search(url, 3, { ...options, cooldown: new VintedCooldown(), fetchImpl: async () => response(++requests === 1 ? 401 : 200) });
    assert.equal(requests, 2);
});
