const escapeHTML = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const formatPrice = (price) => {
    if (typeof price === 'object') {
        return `${parseFloat(price.amount).toFixed(2)} ${price.currency || 'EUR'}`;
    }
    return `${parseFloat(price).toFixed(2)} EUR`;
};

const formatMessage = (item, price, uploadTime) => {
    return `🏷️ <b>${escapeHTML(item.title)}</b>

💰 Price: ${formatPrice(price)}${item.shipping_from ? `\n🚚 Shipping from: ${escapeHTML(item.shipping_from)}` : ''}
📏 Size: ${escapeHTML(item.size_title || 'Unknown')}
📦 Status: ${escapeHTML(item.status || 'Unknown')}${uploadTime && uploadTime !== 'Unknown' ? `\n🕒 Listed: ${escapeHTML(uploadTime)}` : ''}

🔗 <a href="${escapeHTML(item.url)}">View on Vinted</a>`;
};

module.exports = {
    formatPrice,
    formatMessage
};