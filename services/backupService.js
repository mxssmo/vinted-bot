const { DatabaseSync } = require('node:sqlite');
const { mkdirSync, readdirSync, statSync, existsSync, chmodSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const BACKUP_NAME = /^deliveries-\d{4}-\d{2}-\d{2}\.sqlite$/;

class DatabaseBackups {
    constructor(db, directory, { now = Date.now, keep = 7, onError = console.warn } = {}) {
        this.db = db;
        this.directory = resolve(directory);
        this.now = now;
        this.keep = keep;
        this.onError = onError;
        this.lastSuccess = null;
        this.lastError = null;
        this.timer = null;
        // Recover the last known good snapshot even if today's attempt fails.
        try {
            for (const name of readdirSync(this.directory).filter(name => BACKUP_NAME.test(name)).sort().reverse()) {
                try {
                    const filename = join(this.directory, name);
                    this.verify(filename);
                    this.lastSuccess = statSync(filename).mtimeMs;
                    break;
                } catch { /* Try an older snapshot if this one is corrupt. */ }
            }
        } catch { /* The directory is created on the first backup attempt. */ }
    }

    verify(filename) {
        const copy = new DatabaseSync(filename, { readOnly: true });
        try {
            if (copy.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Invalid backup');
        } finally { copy.close(); }
    }

    tick() {
        let temporary;
        try {
            mkdirSync(this.directory, { recursive: true, mode: 0o700 });
            const date = new Date(this.now()).toISOString().slice(0, 10);
            const filename = join(this.directory, `deliveries-${date}.sqlite`);
            if (!existsSync(filename)) {
                temporary = join(this.directory, `.backup-${randomUUID()}.sqlite`);
                // SQL parameters keep paths with quotes safe. VACUUM INTO includes
                // committed WAL data and works with the project's Node 22.13 minimum.
                this.db.prepare('VACUUM main INTO ?').run(temporary);
                chmodSync(temporary, 0o600);
                this.verify(temporary);
                const descriptor = openSync(temporary, 'r');
                try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
                renameSync(temporary, filename);
                temporary = null;
            } else {
                this.verify(filename);
            }
            this.lastSuccess = statSync(filename).mtimeMs;
            this.lastError = null;
            // Only prune our own dated snapshots, after a verified backup exists.
            const backups = readdirSync(this.directory).filter(name => BACKUP_NAME.test(name)).sort().reverse();
            for (const name of backups.slice(this.keep)) unlinkSync(join(this.directory, name));
            return true;
        } catch {
            this.lastError = this.now();
            this.onError('[WARN] Database backup failed; bot continues running. Check backup directory permissions and disk space.');
            return false;
        } finally {
            if (temporary && existsSync(temporary)) {
                try { unlinkSync(temporary); } catch { /* Preserve original failure. */ }
            }
        }
    }

    start() {
        this.tick();
        if (!this.timer) {
            this.timer = setInterval(() => this.tick(), 60 * 60 * 1000);
            this.timer.unref();
        }
    }

    stop() { clearInterval(this.timer); this.timer = null; }
}

module.exports = { DatabaseBackups };
