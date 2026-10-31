const parseVintedURL = (url) => {
    try {
        const decodedURL = decodeURI(url);
        const domainMatch = new URL(decodedURL).origin.match(/^https:\/\/www\.vinted\.([a-z]+(?:\.[a-z]+)?)$/);

        if (!domainMatch) return { validURL: false };

        const domain = domainMatch[1];
        const searchParams = new URL(url).searchParams;

        const brandIds = searchParams.getAll('brand_ids[]');
        const catalogIds = [...searchParams.getAll('catalog[]'), ...searchParams.getAll('catalog_ids[]')];
        const sizeIds = searchParams.getAll('size_ids[]');
        const statusIds = searchParams.getAll('status_ids[]');

        const params = new Map();
        if (brandIds.length) params.set('attribute_ids[brand]', brandIds.join(','));
        if (catalogIds.length) params.set('attribute_ids[catalog]', catalogIds.join(','));
        if (sizeIds.length) params.set('attribute_ids[size]', sizeIds.join(','));
        if (statusIds.length) params.set('attribute_ids[status]', statusIds.join(','));

        for (const [key, value] of searchParams.entries()) {
            if (!key.includes('[]')) {
                const filter = key.match(/^(brand|catalog|size|status|color|material)_ids$/);
                params.set(filter ? `attribute_ids[${filter[1]}]` : key, value);
            }
        }

        for (const filter of ['color', 'material']) {
            const ids = searchParams.getAll(`${filter}_ids[]`);
            if (ids.length) params.set(`attribute_ids[${filter}]`, ids.join(','));
        }
        if (!params.has('page')) params.set('page', '1');
        if (!params.has('per_page')) params.set('per_page', '96');
        const querystring = new URLSearchParams(params).toString();

        return {
            validURL: true,
            domain,
            querystring,
            brandIds,
            catalogIds,
            sizeIds,
            statusIds
        };
    } catch (error) {
        console.error('[ERROR] Failed to parse URL:', error);
        return { validURL: false };
    }
};

module.exports = {
    parseVintedURL
};