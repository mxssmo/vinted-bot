const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { DeliveryStore, destinationKey } = require('../services/deliveryService');
const { SearchStore } = require('../services/searchStore');
const { DatabaseBackups } = require('../services/backupService');
const config = { botToken: '123:fake', chatId: '456', urls: ['https://www.vinted.it/catalog'], priceLimit: 50 };

test('live WAL snapshot restores searches, pause state and delivery history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vinted-backup-'));
    const store = new DeliveryStore(join(directory, 'live.sqlite'));
    const destination = destinationKey(config);
    try {
        const searches = new SearchStore(store.db);
        searches.importConfig(config);
        const [search] = searches.list(destination);
        searches.change(destination, search.id, search.revision, 'pause');
        store.enqueue(destination, 1, { message: 'delivered', photos: [] });
        store.markDelivered(destination, 1);
        store.enqueue(destination, 2, { message: 'pending', photos: [] });
        const backups = new DatabaseBackups(store.db, join(directory, "backup's"), { now: () => Date.parse('2026-10-31T10:00:00Z') });
        assert.equal(backups.tick(), true);
        const restoredPath = join(directory, 'restored.sqlite');
        copyFileSync(join(directory, "backup's", 'deliveries-2026-10-31.sqlite'), restoredPath);
        const restored = new DeliveryStore(restoredPath);
        try {
            const restoredSearches = new SearchStore(restored.db);
            restoredSearches.importConfig(config);
            assert.equal(restoredSearches.list(destination)[0].enabled, 0);
            assert.equal(restored.hasItem(destination, 1), true);
            assert.deepEqual(restored.pending(destination).map(item => item.itemId), ['2']);
        } finally { restored.close(); }
    } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('one snapshot per UTC day, seven retained, unrelated files untouched', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vinted-retention-'));
    const store = new DeliveryStore(':memory:');
    let now = Date.parse('2026-10-20T12:00:00Z');
    const backups = new DatabaseBackups(store.db, directory, { now: () => now });
    try {
        writeFileSync(join(directory, 'manual.sqlite'), 'keep');
        for (let day = 0; day < 10; day++) {
            store.enqueue('123:456', day, { message: String(day), photos: [] });
            assert.equal(backups.tick(), true);
            assert.equal(backups.tick(), true);
            now += 86400000;
        }
        const names = readdirSync(directory);
        assert.equal(names.filter(name => name.startsWith('deliveries-')).length, 7);
        assert.ok(!names.includes('deliveries-2026-10-20.sqlite'));
        assert.ok(names.includes('deliveries-2026-10-29.sqlite'));
        assert.ok(names.includes('manual.sqlite'));
    } finally { backups.stop(); store.close(); rmSync(directory, { recursive: true }); }
});

test('failed partial snapshot is cleaned up and previous good backup is preserved', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vinted-failed-backup-'));
    const store = new DeliveryStore(':memory:');
    let now = Date.parse('2026-10-30T12:00:00Z');
    const warnings = [];
    const backups = new DatabaseBackups(store.db, directory, { now: () => now, onError: warning => warnings.push(warning) });
    try {
        assert.equal(backups.tick(), true);
        const lastSuccess = backups.lastSuccess;
        now += 86400000;
        backups.db = { prepare: () => ({ run: path => { writeFileSync(path, 'partial'); throw Error('disk full'); } }) };
        assert.equal(backups.tick(), false);
        assert.equal(backups.lastSuccess, lastSuccess);
        assert.equal(backups.lastError, now);
        const restarted = new DatabaseBackups(backups.db, directory, { now: () => now, onError: () => {} });
        assert.equal(restarted.lastSuccess, lastSuccess);
        assert.equal(restarted.tick(), false);
        assert.equal(restarted.lastSuccess, lastSuccess);
        assert.equal(warnings.length, 1);
        assert.deepEqual(readdirSync(directory), ['deliveries-2026-10-30.sqlite']);
        assert.ok(existsSync(join(directory, 'deliveries-2026-10-30.sqlite')));
    } finally { store.close(); rmSync(directory, { recursive: true }); }
});
