const { destinationKey } = require('./deliveryService');

const validationError = message => Object.assign(new Error(message), { userFacing: true });

const SUPPORTED_DOMAINS = new Set('it fr es de nl be at pt lu pl cz sk hu ro fi gr hr si lt lv ee dk se co.uk com ie'.split(' '));
const validateSearchURL = value => {
    if (typeof value !== 'string' || value.length > 8000) throw validationError('Paste one Vinted catalog URL.');
    let url;
    try { url = new URL(value.trim()); } catch { throw validationError('Paste a valid Vinted catalog URL.'); }
    const domain = url.hostname.replace(/^www\./, '').replace(/^vinted\./, '');
    if (!SUPPORTED_DOMAINS.has(domain) || !['vinted.' + domain, 'www.vinted.' + domain].includes(url.hostname) ||
        url.protocol !== 'https:' || url.username || url.password || url.port || !/^\/catalog(?:\/|$)/.test(url.pathname)) {
        throw validationError('Use an https://www.vinted…/catalog search URL, not an item or shortened link.');
    }
    url.hostname = `www.vinted.${domain}`;
    url.hash = '';
    return url.href;
};

class SearchStore {
    constructor(db) {
        this.db = db;
        // Fresh page membership is deliberately process-local: persisted sources
        // alone must never release a previous session's queued alerts.
        this.currentMatches = new Map();
        db.exec(`CREATE TABLE IF NOT EXISTS managed_destinations (destination TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS managed_searches (
                id INTEGER PRIMARY KEY AUTOINCREMENT, destination TEXT NOT NULL,
                name TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
                deleted INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
                url_revision INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS delivery_searches (
                destination TEXT NOT NULL, item_id TEXT NOT NULL, search_id INTEGER NOT NULL,
                url_revision INTEGER NOT NULL,
                PRIMARY KEY(destination, item_id, search_id, url_revision)
            );
            CREATE TABLE IF NOT EXISTS telegram_control_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    }

    importConfig(config) {
        const destination = destinationKey(config);
        if (this.db.prepare('SELECT 1 FROM managed_destinations WHERE destination = ?').get(destination)) return;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const [index, url] of (config.urls || [config.url]).filter(Boolean).entries()) {
                this.add(destination, `Search ${index + 1}`, url);
            }
            this.db.prepare('INSERT INTO managed_destinations VALUES (?)').run(destination);
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }

    list(destination) {
        return this.db.prepare('SELECT * FROM managed_searches WHERE destination = ? AND deleted = 0 ORDER BY id').all(destination);
    }

    get(destination, id) {
        return this.db.prepare('SELECT * FROM managed_searches WHERE destination = ? AND id = ? AND deleted = 0').get(destination, id);
    }

    add(destination, name, value) {
        const url = validateSearchURL(value);
        if (typeof name !== 'string' || !name.trim() || name.length > 60) throw validationError('Use a name of 1–60 characters.');
        if (this.list(destination).some(search => search.url === url)) throw validationError('This URL is already saved in this bot.');
        const result = this.db.prepare('INSERT INTO managed_searches (destination, name, url) VALUES (?, ?, ?)').run(destination, name.trim(), url);
        return this.get(destination, Number(result.lastInsertRowid));
    }

    change(destination, id, revision, action, value) {
        const search = this.get(destination, id);
        if (!search || search.revision !== revision) throw validationError('This menu is outdated. Open /searches again.');
        let sql;
        let params = [];
        if (action === 'replace') {
            const url = validateSearchURL(value);
            if (this.list(destination).some(other => other.id !== id && other.url === url)) throw validationError('This URL is already saved in this bot.');
            sql = 'url = ?, url_revision = url_revision + 1';
            params.push(url);
        } else if (action === 'pause') sql = 'enabled = 0';
        else if (action === 'resume') sql = 'enabled = 1, url_revision = url_revision + 1';
        else if (action === 'delete') sql = 'deleted = 1, enabled = 0';
        else throw validationError('Unknown search action.');
        this.db.prepare(`UPDATE managed_searches SET ${sql}, revision = revision + 1 WHERE destination = ? AND id = ?`).run(...params, destination, id);
        return this.get(destination, id);
    }

    isCurrent(destination, search) {
        const current = this.get(destination, search.id);
        return Boolean(current?.enabled && current.url_revision === search.url_revision);
    }

    link(destination, itemId, search) {
        this.db.prepare('INSERT OR IGNORE INTO delivery_searches VALUES (?, ?, ?, ?)')
            .run(destination, String(itemId), search.id, search.url_revision);
    }

    beginCycle() {
        this.currentMatches.clear();
    }

    recordCurrentMatches(destination, search, itemIds) {
        if (!this.isCurrent(destination, search)) return;
        this.currentMatches.set(`${destination}:${search.id}:${search.url_revision}`, new Set(itemIds.map(String)));
    }

    canDeliver(destination, itemId) {
        const managed = this.db.prepare('SELECT 1 FROM managed_destinations WHERE destination = ?').get(destination);
        if (!managed) return true;
        const sources = this.db.prepare(`SELECT ds.search_id, ds.url_revision FROM delivery_searches ds
            JOIN managed_searches s ON s.id = ds.search_id
            WHERE ds.destination = ? AND ds.item_id = ? AND s.destination = ds.destination
            AND s.url_revision = ds.url_revision AND s.enabled = 1 AND s.deleted = 0`).all(destination, String(itemId));
        return sources.some(source => this.currentMatches.get(`${destination}:${source.search_id}:${source.url_revision}`)?.has(String(itemId)));
    }

    state(key, value) {
        if (arguments.length > 1) {
            if (value === null) this.db.prepare('DELETE FROM telegram_control_state WHERE key = ?').run(key);
            else this.db.prepare('INSERT OR REPLACE INTO telegram_control_state VALUES (?, ?)').run(key, JSON.stringify(value));
            return value;
        }
        const row = this.db.prepare('SELECT value FROM telegram_control_state WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : null;
    }
}

module.exports = { SearchStore, validateSearchURL };
