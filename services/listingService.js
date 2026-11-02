const { isAllowedIPhoneModel } = require('../iphone-filter');
const { formatMessage } = require('../utils/mssgFormat');
const { destinationKey } = require('./deliveryService');
const { selectNewItems } = require('./pollingService');

const hasListingId = item => item && (typeof item.id === 'string' || typeof item.id === 'number') && /^\d+$/.test(String(item.id));
const text = value => typeof value === 'string' ? value : undefined;
const priceAmount = price => {
    const value = price && typeof price === 'object' ? price.amount : price;
    if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') return NaN;
    return Number(value);
};

const normalizeListings = (items, domain, onWarning = console.warn) => {
    const origin = `https://www.vinted.${domain}`;
    return items.flatMap((item, index) => {
        try {
            if (!hasListingId(item) || !text(item.title)?.trim()) throw new Error('Invalid identity');
            const amount = priceAmount(item.price);
            if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid price');
            const url = new URL(item.url == null ? `/items/${item.id}` : item.url, origin);
            if (url.origin !== origin || !url.pathname.startsWith('/items/')) throw new Error('Invalid listing URL');
            const secondLine = text(item.item_box?.second_line)?.split(' · ') || [];
            return [{
                ...item,
                url: url.href,
                price: { amount, currency: text(item.price?.currency) || text(item.price?.currency_code) || 'EUR' },
                size_title: text(item.size_title) || secondLine[0],
                status: text(item.status) || secondLine.slice(1).join(' · ')
            }];
        } catch {
            onWarning(`[WARN] Skipping malformed listing at result ${index + 1}`);
            return [];
        }
    });
};

const prepareAlert = item => {
    const timestamp = Number(item.created_at_ts);
    const date = new Date(timestamp * 1000);
    const uploadTime = text(item.listed_at_label)?.trim() ||
        (Number.isFinite(timestamp) && timestamp > 0 && !Number.isNaN(date.getTime()) ? date.toLocaleString() : null);
    const photos = [];
    if (Array.isArray(item.photos) && item.photos.length) {
        photos.push(...item.photos.map(photo => photo?.url));
    } else if (item.photo && typeof item.photo === 'object') {
        photos.push(item.photo.url);
        if (Array.isArray(item.photo.variants)) photos.push(...item.photo.variants.map(photo => photo?.url));
    }
    return {
        message: formatMessage(item, item.price, uploadTime),
        itemUrl: item.url,
        photos: photos.filter(url => {
            if (typeof url !== 'string') return false;
            try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
        }).slice(0, 10)
    };
};

const queueMatchingItems = (items, url, config, store, { onWarning = console.warn, prepare = prepareAlert, searches, searchEntry, enrich } = {}) => {
    const destination = destinationKey(config);
    if (searches && !searches.isCurrent(destination, searchEntry)) return;
    const iphoneSearch = new URL(url).searchParams.getAll('brand_ids[]').includes('54661');
    const matching = items.filter(item => {
        if (!hasListingId(item) || !text(item.title)?.trim()) return false;
        const amount = priceAmount(item.price);
        return Number.isFinite(amount) && amount >= 0 && amount <= config.priceLimit &&
            (!iphoneSearch || isAllowedIPhoneModel(item.title));
    });
    if (searches) {
        searches.recordCurrentMatches(destination, searchEntry, matching.map(item => item.id));
        // A pending item can match multiple searches. Keep all sources so
        // pausing one search does not suppress another active search's match.
        for (const item of matching) {
            if (store.hasItem(destination, item.id)) searches.link(destination, item.id, searchEntry);
        }
    }
    const prepared = [];
    // Bad payloads do not consume one of the five available alert slots.
    for (const item of selectNewItems(matching, store, destination, matching.length)) {
        try {
            prepared.push({ id: item.id, item, payload: prepare(item) });
        } catch {
            onWarning(`[WARN] Skipping alert preparation for item ${item.id}`);
            continue;
        }
        if (prepared.length === 5) break;
    }
    const persist = () => {
        if (searches && !searches.isCurrent(destination, searchEntry)) return;
        for (const { id, payload } of [...prepared].reverse()) {
            // Database failures must propagate; they are not malformed-listing errors.
            store.enqueue(destination, id, payload);
            if (searches) searches.link(destination, id, searchEntry);
        }
    };
    if (!enrich) return persist();
    // Keep synchronous preparation available for callers without enrichment.
    // Only the five selected unseen items require optional page requests.
    return (async () => {
        for (const alert of prepared) {
            if (searches && !searches.isCurrent(destination, searchEntry)) return;
            alert.payload = await enrich(alert.item, alert.payload);
        }
        persist();
    })();
};

module.exports = { hasListingId, normalizeListings, prepareAlert, queueMatchingItems };
