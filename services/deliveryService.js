const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

class DeliveryStore {
    constructor(filename = 'data/deliveries.sqlite') {
        if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
        this.db = new DatabaseSync(filename);
        this.db.exec(`PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS deliveries (
                destination TEXT NOT NULL, item_id TEXT NOT NULL,
                payload TEXT NOT NULL, delivered_at INTEGER,
                PRIMARY KEY (destination, item_id)
            );
            CREATE TABLE IF NOT EXISTS destination_retries (
                destination TEXT PRIMARY KEY, retry_at INTEGER NOT NULL
            )`);
        // Additive migration preserves existing queued messages and history.
        const columns = this.db.prepare('PRAGMA table_info(deliveries)').all();
        if (!columns.some(column => column.name === 'failed_at')) {
            this.db.exec('ALTER TABLE deliveries ADD COLUMN failed_at INTEGER');
        }
    }

    enqueue(destination, itemId, payload) {
        this.db.prepare('INSERT OR IGNORE INTO deliveries (destination, item_id, payload, delivered_at) VALUES (?, ?, ?, NULL)')
            .run(destination, String(itemId), JSON.stringify(payload));
    }

    hasItem(destination, itemId) {
        return Boolean(this.db.prepare('SELECT 1 FROM deliveries WHERE destination = ? AND item_id = ?')
            .get(destination, String(itemId)));
    }

    pending(destination) {
        return this.db.prepare('SELECT item_id, payload FROM deliveries WHERE destination = ? AND delivered_at IS NULL AND failed_at IS NULL ORDER BY rowid')
            .all(destination).map(row => ({ itemId: row.item_id, ...JSON.parse(row.payload) }));
    }

    markDelivered(destination, itemId) {
        this.db.prepare('UPDATE deliveries SET delivered_at = ? WHERE destination = ? AND item_id = ?')
            .run(Date.now(), destination, String(itemId));
    }

    markFailed(destination, itemId) {
        this.db.prepare('UPDATE deliveries SET failed_at = ? WHERE destination = ? AND item_id = ?')
            .run(Date.now(), destination, String(itemId));
    }

    defer(destination, seconds) {
        this.db.prepare('INSERT OR REPLACE INTO destination_retries VALUES (?, ?)')
            .run(destination, Date.now() + seconds * 1000);
    }

    ready(destination) {
        const row = this.db.prepare('SELECT retry_at FROM destination_retries WHERE destination = ?').get(destination);
        return !row || row.retry_at <= Date.now();
    }

    close() { this.db.close(); }
}

// Stable across token rotations; the numeric prefix identifies the Telegram bot.
const destinationKey = config => `${config.botToken.split(':')[0]}:${config.chatId}`;

const deliverPending = async (store, config, send, { pause = () => new Promise(resolve => setTimeout(resolve, 1000)), onError = () => {}, canDeliver = () => true, stopped = () => false } = {}) => {
    const destination = destinationKey(config);
    if (!store.ready(destination)) return;
    for (const delivery of store.pending(destination)) {
        if (stopped()) break;
        if (!canDeliver(destination, delivery.itemId)) continue;
        try {
            await send(delivery.message, delivery.photos, config);
            store.markDelivered(destination, delivery.itemId);
        } catch (error) {
            if (error.destinationFailure) {
                const seconds = Number.isFinite(error.retryAfter) && error.retryAfter > 0
                    ? Math.ceil(error.retryAfter) : 180;
                store.defer(destination, seconds);
                onError(`Telegram destination unavailable; queued messages retained, retry after ${seconds}s`);
                break;
            }
            if (error.permanent) {
                store.markFailed(destination, delivery.itemId);
                onError(`Delivery rejected permanently for item ${delivery.itemId}; saved as failed, continuing`);
            } else {
                // Network errors may contain the Telegram URL and secret token.
                onError(`Delivery failed for item ${delivery.itemId}; queued for retry, continuing`);
            }
        }
        await pause();
    }
};

module.exports = { DeliveryStore, destinationKey, deliverPending };
