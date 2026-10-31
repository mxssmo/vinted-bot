// Telegram retains unconfirmed updates for at most 24 hours. Rebase after
// 48 hours without received updates, before its week-long ID reset can occur.
const REBASE_AFTER = 48 * 60 * 60 * 1000;

class TelegramCursor {
    constructor(searches, botId, now = Date.now) {
        this.searches = searches;
        this.botId = botId;
        this.now = now;
    }

    get legacyFloor() { return this.searches.state(`legacy-offset:${this.botId}`); }

    pollOffset() {
        const offset = this.searches.state(`offset:${this.botId}`) || 0;
        const lastUpdate = this.searches.state(`last-update-at:${this.botId}`);
        // An interrupted upgrade recovery must keep its original replay guard.
        if (this.legacyFloor !== null) return offset;
        const legacy = offset > 0 && lastUpdate === null;
        const idle = lastUpdate !== null && this.now() - lastUpdate >= REBASE_AFTER;
        if (!legacy && !idle) return offset;
        this.searches.db.exec('BEGIN IMMEDIATE');
        try {
            if (legacy) this.searches.state(`legacy-offset:${this.botId}`, offset);
            this.searches.state(`offset:${this.botId}`, 0);
            this.searches.state(`last-update-at:${this.botId}`, this.now());
            this.searches.db.prepare('DELETE FROM telegram_control_state WHERE key LIKE ?').run(`session:${this.botId}:%`);
            this.searches.db.exec('COMMIT');
        } catch (error) { this.searches.db.exec('ROLLBACK'); throw error; }
        return 0;
    }

    finishBatch() {
        // On upgrade, an unconfirmed batch below the old cursor is ambiguous:
        // it may be an old replay or a reset ID. It is used only to reopen menus.
        // Subsequent input is handled normally with the new persisted cursor.
        if (this.legacyFloor !== null) this.searches.state(`legacy-offset:${this.botId}`, null);
    }
}

module.exports = { TelegramCursor, REBASE_AFTER };
