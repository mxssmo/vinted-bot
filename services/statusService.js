const { destinationKey } = require('./deliveryService');
const { vintedCooldown } = require('./vintedCooldown');
const formatTime = timestamp => timestamp ? new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Rome'
}).format(new Date(timestamp)) : 'Not yet recorded';

class BotStatus {
    constructor(store, searches, { cooldown = vintedCooldown, backups, now = Date.now } = {}) {
        this.store = store;
        this.searches = searches;
        this.cooldown = cooldown;
        this.backups = backups;
        this.now = now;
        store.db.exec(`CREATE TABLE IF NOT EXISTS search_health (
            destination TEXT NOT NULL, search_id INTEGER NOT NULL, url_revision INTEGER NOT NULL,
            last_attempt INTEGER NOT NULL, last_success INTEGER, last_error TEXT,
            PRIMARY KEY(destination, search_id, url_revision)
        )`);
    }

    record(config, entry, error = null) {
        const code = error ? (error.code === 'VINTED_COOLDOWN' ? 'Cooldown' : 'Fetch or processing error') : null;
        this.store.db.prepare(`INSERT INTO search_health VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(destination, search_id, url_revision) DO UPDATE SET
                last_attempt = excluded.last_attempt,
                last_success = COALESCE(excluded.last_success, search_health.last_success),
                last_error = excluded.last_error`)
            .run(destinationKey(config), entry.id, entry.url_revision, this.now(), error ? null : this.now(), code);
    }

    view(config) {
        const destination = destinationKey(config);
        const searches = this.searches.list(destination);
        const active = searches.filter(search => search.enabled);
        const health = this.store.db.prepare(`SELECT h.*, s.name FROM search_health h JOIN managed_searches s ON s.id = h.search_id
            WHERE h.destination = ? AND s.destination = h.destination AND s.url_revision = h.url_revision AND s.deleted = 0`).all(destination);
        const pending = this.store.db.prepare('SELECT item_id FROM deliveries WHERE destination = ? AND delivered_at IS NULL AND failed_at IS NULL').all(destination);
        const eligible = pending.filter(item => this.searches.canDeliver(destination, item.item_id)).length;
        const failed = this.store.db.prepare('SELECT COUNT(*) AS total FROM deliveries WHERE destination = ? AND failed_at IS NOT NULL').get(destination).total;
        const latest = field => Math.max(0, ...health.map(row => row[field] || 0));
        const telegramRetry = this.store.db.prepare('SELECT retry_at FROM destination_retries WHERE destination = ?').get(destination)?.retry_at || 0;
        const domains = [...new Set(active.map(search => new URL(search.url).hostname.replace(/^www\.vinted\./, '')))];
        const cooldowns = domains.map(domain => ({ domain, until: this.cooldown.retryAt(domain) })).filter(item => item.until > this.now());
        const failures = health.filter(row => row.last_error && row.last_error !== 'Cooldown');
        const lines = [
            'Bot status — running',
            `Searches: ${active.length} active · ${searches.length - active.length} paused`,
            `Last successful check: ${formatTime(latest('last_success'))}`,
            `Last check attempt: ${formatTime(latest('last_attempt'))}`,
            `Alerts queued: ${eligible} eligible · ${pending.length - eligible} held`,
            `Failed alerts: ${failed}`,
            `Recent search errors: ${failures.length}`,
            ...failures.slice(0, 5).map(row => `• ${row.name}: ${row.last_error}`),
            `Telegram cooldown: ${telegramRetry > this.now() ? `until ${formatTime(telegramRetry)}` : 'None'}`,
            `Vinted cooldowns: ${cooldowns.length ? cooldowns.map(item => `${item.domain} until ${formatTime(item.until)}`).join('; ') : 'None'}`,
            `Last backup: ${formatTime(this.backups?.lastSuccess)}`
        ];
        if (this.backups?.lastError) lines.push(`Backup warning: last attempt failed at ${formatTime(this.backups.lastError)}`);
        lines.push('Times: Europe/Rome. Held alerts wait for a fresh newest-page match.');
        return { text: lines.join('\n'), reply_markup: { inline_keyboard: [
            [{ text: 'Refresh status', callback_data: 's:status' }],
            [{ text: '‹ Searches', callback_data: 's:list:0' }]
        ] } };
    }
}

module.exports = { BotStatus, formatTime };
