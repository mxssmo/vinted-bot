const escapeHTML = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const formatPrice = (price) => {
    const amount = Number(price && typeof price === 'object' ? price.amount : price).toFixed(2);
    const currency = price?.currency || price?.currency_code || 'EUR';
    const symbol = { EUR: '€', GBP: '£', USD: '$' }[currency];
    return symbol ? `${symbol}${amount}` : `${amount} ${currency}`;
};

const detail = value => {
    if (typeof value !== 'string') return null;
    const label = value.replace(/\s+/g, ' ').trim();
    return label && !/^(unknown|sconosciut[oa]|n\/?a|[-—])$/i.test(label) ? label : null;
};

const formatMessage = (item, price, uploadTime) => {
    const shipping = detail(item.shipping_from);
    const size = detail(item.size_title);
    const color = detail(item.color_title);
    const condition = detail(item.status);
    const listed = detail(uploadTime);
    const lines = [
        `<b>${escapeHTML(item.title)}</b>`,
        '',
        `<b>${escapeHTML(formatPrice(price))}</b>${shipping ? ` · 🚚 Shipping from ${escapeHTML(shipping)}` : ''}`
    ];
    const attributes = [size && `📏 ${escapeHTML(size)}`, color && `🎨 ${escapeHTML(color)}`].filter(Boolean);
    if (attributes.length) lines.push(attributes.join(' · '));
    if (condition) lines.push(`✨ ${escapeHTML(condition)}`);
    const seen = new Set();
    for (const attribute of Array.isArray(item.extra_attributes) ? item.extra_attributes : []) {
        const label = detail(attribute?.label);
        const value = detail(attribute?.value);
        if (!label || !value || seen.has(label.toLocaleLowerCase())) continue;
        seen.add(label.toLocaleLowerCase());
        lines.push(`${escapeHTML(label)}: ${escapeHTML(value)}`);
    }
    if (listed) lines.push(`🕒 Listed: ${escapeHTML(listed)}`);
    return lines.join('\n');
};

module.exports = {
    formatPrice,
    formatMessage
};
