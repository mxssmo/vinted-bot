const cheerio = require('cheerio');
const { cookies, fetchCookie, RELIABLE_USER_AGENTS } = require('./cookieService');
const { VintedCooldown, vintedCooldown } = require('./vintedCooldown');
const { prepareAlert } = require('./listingService');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
// Optional item-page lookups back off independently: a blocked page must not
// prevent catalog searches and ordinary alerts from working.
const pageCooldown = new VintedCooldown();

const attributeText = value => {
    const text = value.replace(/\s+/g, ' ').trim();
    return text && !/^(unknown|sconosciut[oa]|n\/?a|[-—]|non specificat[oa]|not specified)$/i.test(text) ? text : null;
};

const attributesFromDocument = $ => {
    const attributes = [];
    const seen = new Set();
    $('.details-list__item, [data-testid^="item-attributes-"]').each((_, element) => {
        const row = $(element);
        // React's streamed HTML keeps real sidebar content in hidden S:*
        // containers until hydration. These are data, not hidden UI variants.
        const hidden = row.parents().addBack().filter('[hidden], [aria-hidden="true"]')
            .toArray().some(node => !/^S:[\da-z]+$/i.test($(node).attr('id') || ''));
        if (hidden) return;
        let cells = row.children('.details-list__item-value');
        // Some item-page versions omit the details-list classes but keep the
        // attribute test ID and its two label/value children.
        if (cells.length !== 2 && row.attr('data-testid')?.startsWith('item-attributes-')) cells = row.children('div');
        if (cells.length !== 2) return;
        const read = cell => {
            const copy = cell.clone();
            copy.find('button, svg, script, style, [hidden], [aria-hidden="true"]').remove();
            return attributeText(copy.text());
        };
        const label = read(cells.eq(0));
        const value = read(cells.eq(1));
        if (!label || !value) return;
        const identity = label.toLocaleLowerCase();
        if (seen.has(identity)) return;
        seen.add(identity);
        const key = (cells.eq(1).attr('itemprop') || row.attr('data-testid')?.replace(/^item-attributes-/, '') || '')
            .replace(/[-\s]/g, '_');
        attributes.push({ key, label, value });
    });
    return attributes;
};

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
    const color = $('[data-testid="item-attributes-color"] [itemprop="color"]')
        .first().text().replace(/\s+/g, ' ').trim();
    const colorTitle = color && color.length <= 120 && !/^(unknown|sconosciut[oa]|n\/a|[-—])$/i.test(color)
        ? color : null;
    const attributes = attributesFromDocument($);
    const details = {
        shipping_from: shippingFromDocument($), listed_at_label: listed, color_title: colorTitle,
        extra_attributes: attributes.filter(attribute => !['size', 'status', 'color', 'upload_date'].includes(attribute.key))
            .map(({ label, value }) => ({ label, value }))
    };
    // Fill the compact fields from the actual item page as well, so they are
    // shown even when the catalogue response did not contain them.
    for (const [key, field] of [['size', 'size_title'], ['status', 'status'], ['color', 'color_title'], ['upload_date', 'listed_at_label']]) {
        const value = attributes.find(attribute => attribute.key === key)?.value;
        if (value && (!['color', 'upload_date'].includes(key) || value.length <= 120)) details[field] = value;
    }
    return details;
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
    if (!details) return payload;
    const available = Object.fromEntries(Object.entries(details).filter(([, value]) => Array.isArray(value) ? value.length : value));
    if (!Object.keys(available).length) return payload;
    return { ...payload, message: prepareAlert({ ...item, ...available }).message };
};

module.exports = { parseShippingFrom, parseItemPageDetails, getItemPageDetails, enrichItemPage };
