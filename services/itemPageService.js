const cheerio = require('cheerio');
const { cookies, fetchCookie, RELIABLE_USER_AGENTS } = require('./cookieService');
const { VintedCooldown, vintedCooldown } = require('./vintedCooldown');
const { prepareAlert } = require('./listingService');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
// Optional item-page lookups back off independently: a blocked page must not
// prevent catalog searches and ordinary alerts from working.
const pageCooldown = new VintedCooldown();

const shippingFromDocument = $ => {
    // This is the actual visible shipping banner, not the item total, service
    // fee, translation strings or recommended listings' prices.
    const label = $('[data-testid="item-shipping-banner-price"]').first().text().replace(/\s+/g, ' ').trim();
    const money = /^(?:(?:da|from|à partir de|ab|desde|vanaf|a partir de|od)\s+)?(?:(€|£|\$|EUR|GBP|USD)\s*(\d+(?:[.,]\d{2})?)|(\d+(?:[.,]\d{2})?)\s*(€|£|\$|EUR|GBP|USD))$/i.exec(label);
    if (!money) return null;
    const amount = money[2] || money[3];
    const currency = money[1] || money[4];
    if (!Number.isFinite(Number(amount.replace(',', '.')))) return null;
    return `${amount} ${currency}`;
};

const parseItemPageDetails = html => {
    const $ = cheerio.load(html);
    // The value is a sibling of the "Caricato" label in the real item page.
    const label = $('[data-testid="item-attributes-upload_date"] [itemprop="upload_date"]')
        .first().text().replace(/\s+/g, ' ').trim();
    const listed = label && label.length <= 120 && !/^(unknown|sconosciut[oa]|n\/a|[-—])$/i.test(label)
        ? label : null;
    return { shipping_from: shippingFromDocument($), listed_at_label: listed };
};

const parseShippingFrom = html => parseItemPageDetails(html).shipping_from;

const getItemPageDetails = async (item, {
    fetchImpl = fetch, cookieFetcher = fetchCookie, cooldown = pageCooldown,
    catalogCooldown = vintedCooldown, onWarning = console.warn
} = {}) => {
    try {
        const url = new URL(item.url);
        const match = url.hostname.match(/^www\.vinted\.([a-z]+(?:\.[a-z]+)?)$/);
        if (url.protocol !== 'https:' || !match || !url.pathname.startsWith('/items/')) return null;
        const domain = match[1];
        catalogCooldown.assertReady(domain);
        cooldown.assertReady(domain);
        const token = cookies.get(domain) || await cookieFetcher(domain);
        const response = await fetchImpl(url.href, {
            headers: {
                'user-agent': RELIABLE_USER_AGENTS[0],
                Cookie: `access_token_web=${token}`,
                accept: 'text/html',
                'accept-language': domain === 'it' ? 'it-IT,it;q=0.9' : 'en-GB,en;q=0.9'
            },
            signal: AbortSignal.timeout(10000)
        });
        cooldown.checkResponse(domain, response);
        if (!response.ok) throw new Error('Item page unavailable');
        return parseItemPageDetails(await response.text());
    } catch (error) {
        if (error.code !== 'VINTED_COOLDOWN') {
            onWarning(`[WARN] Item-page details unavailable for item ${item.id}; sending alert without optional details`);
        }
        return null;
    }
};

const enrichItemPage = async (item, payload, { lookup = getItemPageDetails } = {}) => {
    const details = await lookup(item);
    if (!details || (!details.shipping_from && !details.listed_at_label)) return payload;
    return { ...payload, message: prepareAlert({ ...item, ...details }).message };
};

module.exports = { parseShippingFrom, parseItemPageDetails, getItemPageDetails, enrichItemPage };
