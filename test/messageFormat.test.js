const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatMessage, formatPrice } = require('../utils/mssgFormat');

test('compact caption puts price first and combines size and color', () => {
    assert.equal(formatMessage({ title: 'Shirt', size_title: 'L', color_title: 'Black', status: 'New with tags', shipping_from: '€2.99' }, 4, '2 min fa'),
        '<b>Shirt</b>\n\n<b>€4.00</b> · 🚚 Shipping from €2.99\n📏 L · 🎨 Black\n✨ New with tags\n🕒 Listed: 2 min fa');
    assert.equal(formatPrice({ amount: 4, currency: 'GBP' }), '£4.00');
    assert.equal(formatPrice({ amount: 4, currency: 'PLN' }), '4.00 PLN');
});

test('missing optional details disappear without empty rows or separators', () => {
    assert.equal(formatMessage({ title: 'Shirt', size_title: 'Unknown', status: 'N/A', color_title: ' — ' }, 4, 'Unknown'), '<b>Shirt</b>\n\n<b>€4.00</b>');
    assert.ok(formatMessage({ title: 'Shirt', color_title: 'Black' }, 4).endsWith('\n🎨 Black'));
    assert.ok(formatMessage({ title: 'Shirt', size_title: 'L' }, 4).endsWith('\n📏 L'));
});

test('additional attributes are escaped and missing or duplicate entries are omitted', () => {
    const message = formatMessage({ title: 'Shirt', extra_attributes: [
        { label: 'Materiale', value: 'Cotone & lino' },
        { label: '<Misura>', value: '<52 cm>' },
        { label: 'materiale', value: 'duplicate' },
        { label: 'Vuoto', value: 'Unknown' },
        { label: '', value: 'missing label' }, null, { label: 'Invalid', value: {} }
    ] }, 4);
    assert.ok(message.includes('Materiale: Cotone &amp; lino'));
    assert.ok(message.includes('&lt;Misura&gt;: &lt;52 cm&gt;'));
    for (const absent of ['duplicate', 'Unknown', 'missing label', 'Invalid:']) assert.ok(!message.includes(absent));
});
