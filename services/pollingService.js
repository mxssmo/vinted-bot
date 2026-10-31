// Always request the newest page, including when a saved URL points elsewhere.
const scanSearch = async ({ url, search, onItems, pageSize = 96 }) => {
    const latest = new URL(url);
    latest.searchParams.set('page', '1');
    latest.searchParams.set('order', 'newest_first');
    latest.searchParams.set('per_page', String(pageSize));
    const result = await search(latest.href);
    if (!Array.isArray(result?.items)) throw new Error('Search did not return an items array');
    const validItems = result.items.filter(item => item && ['string', 'number'].includes(typeof item.id) && /^\d+$/.test(String(item.id)));
    if (validItems.length !== result.items.length) console.warn('[WARN] Skipping listings with invalid IDs');
    await onItems(validItems);
};

// Input is newest first. Count only items not already queued or delivered.
const selectNewItems = (items, store, destination, limit = 5) => {
    const seen = new Set();
    return items.filter(item => {
        const id = String(item.id);
        if (seen.has(id) || store.hasItem(destination, id)) return false;
        seen.add(id);
        return true;
    }).slice(0, limit);
};

module.exports = { scanSearch, selectNewItems };
