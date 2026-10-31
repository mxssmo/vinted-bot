const { dirname, join } = require('node:path');
const { DatabaseBackups } = require('./services/backupService');
const { BotStatus } = require('./services/statusService');
const { existsSync } = require('node:fs');
if (existsSync('.env')) process.loadEnvFile('.env');
const { DeliveryStore, destinationKey, deliverPending } = require('./services/deliveryService');
const { SearchStore } = require('./services/searchStore');
const { startTelegramControl } = require('./services/telegramControl');
const botConf = require('./config/botConfigs');
const { scanSearch } = require('./services/pollingService');
const {search} = require ('./services/vintedService');
const { enrichItemPage } = require('./services/itemPageService');
const { queueMatchingItems } = require('./services/listingService');
const {sendMessageToTelegram} = require("./services/telegramService");







// Main polling function
const pollForNewItems = async (interval = 300000) => {
    console.log(`[INFO] Starting to poll for new items every ${interval / 1000 / 60} minutes.`);
    for (const [index, config] of botConf.entries()) {
        if (!/^\d+:[^\s]+$/.test(config.botToken || '') || !config.chatId) {
            throw new Error(`Missing or invalid Telegram credentials for configuration ${index + 1}`);
        }
    }
    const databasePath = process.env.DELIVERY_DB_PATH || 'data/deliveries.sqlite';
    const store = new DeliveryStore(databasePath);

    const searches = new SearchStore(store.db);
    for (const config of botConf) searches.importConfig(config);
    const backups = new DatabaseBackups(store.db, process.env.DELIVERY_BACKUP_DIR || join(dirname(databasePath), 'backups'));
    const status = new BotStatus(store, searches, { backups });
    backups.start();
    const controls = startTelegramControl(searches, botConf, { statusProvider: config => status.view(config) });
    let stopping = false;
    let wake;
    const stop = () => { stopping = true; controls.stop(); wake?.(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const deliveryOptions = {
        onError: console.error,
        canDeliver: (destination, itemId) => searches.canDeliver(destination, itemId),
        stopped: () => stopping
    };

    const fetchAndLogNewItems = async () => {
        for (const config of botConf) {
            const destination = destinationKey(config);
            for (const entry of searches.list(destination)) {
                if (stopping) return;
                if (!searches.isCurrent(destination, entry)) continue;
                const url = entry.url;
                console.log(`[INFO] Fetching items from: ${url}`);
                try {
                    await scanSearch({
                        url, search,
                        onItems: async items => {
                            if (!stopping) await queueMatchingItems(items, url, config, store, {
                                searches, searchEntry: entry,
                                enrich: (item, payload) => stopping ? payload : enrichItemPage(item, payload)
                            });
                        }
                    });
                    status.record(config, entry);
                } catch (error) {
                    status.record(config, entry, error);
                    console.error(`[ERROR] Failed to fetch from ${url}:`, error);

                    if (error.code === 'VINTED_COOLDOWN') {
                        // Other searches on this domain are gated before network
                        // access; searches on other domains can still proceed.
                        console.log(`[WARN] ${error.message}`);
                        continue;
                    }
                    await new Promise(resolve => setTimeout(resolve, 10000));
                    continue;
                }
            }
        }
    };

    const runPolling = async () => {
        while (!stopping) {
            try {
                // Pending alerts require a matching newest-page result this cycle.
                // Failed fetches leave those alerts held until a later successful scan.
                searches.beginCycle();
                await fetchAndLogNewItems();
                for (const config of botConf) {
                    await deliverPending(store, config, sendMessageToTelegram, deliveryOptions);
                }
            } catch (error) {
                console.error('[ERROR] Polling cycle failed:', error);
            }
            if (!stopping) await new Promise(resolve => {
                const timer = setTimeout(() => { wake = null; resolve(); }, interval);
                wake = () => { clearTimeout(timer); wake = null; resolve(); };
            });
        }
    };

    try { await runPolling(); }
    finally {
        controls.stop();
        backups.stop();
        await controls.done;
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        store.close();
    }

};


if (require.main === module) {
    pollForNewItems(180000).catch(error => {
        console.error('[ERROR]', error.message);
        process.exitCode = 1;
    });
}