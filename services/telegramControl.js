const { TelegramCursor } = require('./telegramCursor');
const { destinationKey } = require('./deliveryService');
const { validateSearchURL } = require('./searchStore');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const button = (text, data) => ({ text, callback_data: data });
const PAGE_SIZE = 8;

const createTelegramAPI = (token, { fetchImpl = fetch, signal } = {}) => async (method, payload = {}) => {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
        const error = new Error('Telegram control request failed');
        error.status = Number(data.error_code || response.status);
        error.unchanged = /message is not modified/i.test(data.description || '');
        error.retryAfter = Number(data.parameters?.retry_after);
        throw error;
    }
    return data.result;
};

const listView = (searches, destination, page = 0, notice = '') => {
    const all = searches.list(destination);
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(all.length / PAGE_SIZE) - 1)));
    const rows = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(search => [
        button(`${search.enabled ? '🟢' : '⏸'} ${search.name}`.slice(0, 60), `s:open:${search.id}`)
    ]);
    const navigation = [];
    if (page > 0) navigation.push(button('‹ Previous', `s:list:${page - 1}`));
    if ((page + 1) * PAGE_SIZE < all.length) navigation.push(button('Next ›', `s:list:${page + 1}`));
    if (navigation.length) rows.push(navigation);
    rows.push([button('＋ Add URL', 's:add'), button('Status', 's:status')]);
    return {
        text: `${notice ? notice + '\n\n' : ''}Your searches (${all.length})\n${all.length ? 'Choose a search to manage it.' : 'No URLs saved. Tap Add URL to begin.'}`,
        reply_markup: { inline_keyboard: rows }
    };
};

const detailView = search => ({
    text: `${search.name}\nStatus: ${search.enabled ? 'Active' : 'Paused'}\n\n${search.url.slice(0, 1800)}`,
    reply_markup: { inline_keyboard: [
        [button('Replace URL', `s:replace:${search.id}:${search.revision}`)],
        [button(search.enabled ? 'Pause' : 'Resume', `s:${search.enabled ? 'pause' : 'resume'}:${search.id}:${search.revision}`),
            button('Delete', `s:delete:${search.id}:${search.revision}`)],
        [button('‹ All searches', 's:list:0')]
    ] }
});

class TelegramController {
    constructor(searches, configs, { statusProvider = () => ({ text: 'Status tracking is unavailable.' }), now = Date.now } = {}) {
        this.searches = searches;
        this.configs = configs;
        this.statusProvider = statusProvider;
        this.now = now;
    }

    plan(update) {
        const callback = update.callback_query;
        const message = callback?.message || update.message;
        const from = callback?.from || message?.from;
        const config = this.configs.find(candidate => {
            const owner = candidate.adminUserId || process.env.TELEGRAM_ADMIN_USER_ID ||
                (/^\d+$/.test(String(candidate.chatId)) ? candidate.chatId : null);
            return owner && String(message?.chat?.id) === String(candidate.chatId) && String(from?.id) === String(owner) && !from?.is_bot;
        });
        if (!config) return callback ? [{ method: 'answerCallbackQuery', payload: { callback_query_id: callback.id, text: 'Not authorized.' } }] : [];
        const destination = destinationKey(config);
        const sessionKey = `session:${destination}:${from.id}`;
        const output = [];
        if (callback) output.push({ method: 'answerCallbackQuery', payload: { callback_query_id: callback.id } });
        const display = view => output.push({
            method: callback ? 'editMessageText' : 'sendMessage',
            payload: { chat_id: config.chatId, ...(callback ? { message_id: message.message_id } : {}),
                link_preview_options: { is_disabled: true }, ...view }
        });
        const prompt = text => display({ text, reply_markup: { inline_keyboard: [[button('Cancel', 's:list:0')]] } });
        const saveSession = value => this.searches.state(sessionKey, value ? { ...value, expires: Date.now() + 15 * 60000 } : null);
        const list = notice => display(listView(this.searches, destination, 0, notice));
        try {
            if (callback) {
                if (callback.data === 's:status') { display(this.statusProvider(config)); return output; }
                const match = /^s:(list|add|open|replace|pause|resume|delete|confirm)(?::(\d+))?(?::(\d+))?$/.exec(callback.data || '');
                if (!match) return output;
                const [, action, rawId, rawRevision] = match;
                const id = Number(rawId);
                const revision = Number(rawRevision);
                if (action === 'list') {
                    saveSession(null);
                    display(listView(this.searches, destination, id));
                } else if (action === 'add') {
                    saveSession({ mode: 'add_url' });
                    prompt('Paste the Vinted catalog URL you want to add.');
                } else {
                    const search = this.searches.get(destination, id);
                    if (!search || (action !== 'open' && search.revision !== revision)) throw Object.assign(new Error('This menu is outdated. Open /searches again.'), { userFacing: true });
                    if (action === 'open') {
                        saveSession(null);
                        display(detailView(search));
                    } else if (action === 'replace') {
                        saveSession({ mode: 'replace', id, revision });
                        prompt(`Paste the new URL for ${search.name}. The old URL will be replaced.`);
                    } else if (action === 'delete') {
                        display({ text: `Delete “${search.name}”? It will stop being checked.`, reply_markup: { inline_keyboard: [
                            [button('Delete this URL', `s:confirm:${id}:${revision}`)], [button('Keep it', `s:open:${id}`)]
                        ] } });
                    } else {
                        const updated = this.searches.change(destination, id, revision, action === 'confirm' ? 'delete' : action);
                        saveSession(null);
                        if (updated) display(detailView(updated));
                        else list('URL deleted.');
                    }
                }
            } else {
                const value = (message.text || '').trim();
                if (!value) return output;
                if (/^\/status(?:@\w+)?(?:\s|$)/i.test(value)) { display(this.statusProvider(config)); return output; }
                if (/^\/(?:start|searches|list|cancel)(?:@\w+)?(?:\s|$)/i.test(value)) {
                    saveSession(null);
                    list();
                    return output;
                }
                if (value.startsWith('/')) { prompt('Use /searches to manage URLs, /status to check the bot, or /cancel to cancel.'); return output; }
                let session = this.searches.state(sessionKey);
                if (session?.expires < Date.now()) { saveSession(null); session = null; }
                if (!session) {
                    if (!/^https:\/\//i.test(value)) return output;
                    session = { mode: 'add_url' };
                }
                if (session.mode === 'add_url') {
                    const url = validateSearchURL(value);
                    saveSession({ mode: 'add_name', url });
                    prompt('Give this search a short name (for example, “Shoes”).');
                } else if (session.mode === 'add_name') {
                    this.searches.add(destination, value, session.url);
                    saveSession(null);
                    list('URL added. It will be checked on the next cycle.');
                } else if (session.mode === 'replace') {
                    this.searches.change(destination, session.id, session.revision, 'replace', value);
                    saveSession(null);
                    list('URL replaced. It will be checked on the next cycle.');
                }
            }
        } catch (error) {
            // Only validation errors are safe to show. Storage failures must be retried.
            if (!error.userFacing) throw error;
            prompt(error.message);
        }
        return output;
    }

    async handle(update, api, botId, { silentRecovery = false } = {}) {
        const key = `offset:${botId}`;
        const offset = this.searches.state(key) || 0;
        if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) return;
        let operations;
        // Mutations and update acknowledgement commit together: redelivery cannot add/delete twice.
        this.searches.db.exec('BEGIN IMMEDIATE');
        try {
            const legacyFloor = this.searches.state(`legacy-offset:${botId}`);
            if (legacyFloor !== null && update.update_id < legacyFloor) {
                // Never replay a possibly already-applied mutation during an
                // upgrade from a cursor without timestamps. Reopen a safe menu.
                const recovered = update.callback_query
                    ? { ...update, callback_query: { ...update.callback_query, data: update.callback_query.data === 's:status' ? 's:status' : 's:list:0' } }
                    : { ...update, message: { ...update.message, text: /^\/status(?:@\w+)?(?:\s|$)/i.test(update.message?.text || '') ? '/status' : '/searches' } };
                operations = silentRecovery ? [] : this.plan(recovered);
            } else operations = this.plan(update);
            this.searches.state(key, update.update_id + 1);
            this.searches.state(`last-update-at:${botId}`, this.now());
            this.searches.db.exec('COMMIT');
        } catch (error) { this.searches.db.exec('ROLLBACK'); throw error; }
        for (const operation of operations) {
            try { await api(operation.method, operation.payload); }
            catch (error) {
                if (error.unchanged) continue;
                // Mutations are already saved. /searches can always recover the menu.
                console.warn('[WARN] Telegram menu response failed; reopen /searches to refresh.');
            }
        }
    }
}

const startTelegramControl = (searches, configs, { apiFactory = createTelegramAPI, onError = console.warn, statusProvider, now = Date.now } = {}) => {
    const abort = new AbortController();
    const groups = new Map();
    for (const config of configs) {
        const botId = config.botToken.split(':')[0];
        if (!groups.has(botId)) groups.set(botId, []);
        groups.get(botId).push(config);
    }
    const wait = ms => new Promise(resolve => {
        if (abort.signal.aborted) return resolve();
        const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms);
        abort.signal.addEventListener('abort', done, { once: true });
    });
    const workers = [...groups].map(async ([botId, botConfigs]) => {
        const api = apiFactory(botConfigs[0].botToken, { signal: abort.signal });
        const controller = new TelegramController(searches, botConfigs, { statusProvider, now });
        const cursor = new TelegramCursor(searches, botId, now);
        let configured = false;
        while (!abort.signal.aborted) {
            try {
                if (!configured) {
                    const webhook = await api('getWebhookInfo');
                    if (webhook.url) {
                        onError(`[WARN] Telegram search menu disabled for bot ${botId}: an existing webhook is configured.`);
                        return;
                    }
                    await api('setMyCommands', { commands: [
                        { command: 'searches', description: 'Manage saved Vinted URLs' },
                        { command: 'status', description: 'Show checks, queued alerts and cooldowns' },
                        { command: 'cancel', description: 'Cancel adding or replacing a URL' }
                    ] });
                    configured = true;
                }
                const updates = await api('getUpdates', {
                    offset: cursor.pollOffset(), timeout: 25,
                    allowed_updates: ['message', 'callback_query']
                });
                const recoveryMenus = new Map();
                const legacyFloor = cursor.legacyFloor;
                if (legacyFloor !== null) {
                    for (const update of updates) {
                        const chat = update.callback_query?.message?.chat?.id || update.message?.chat?.id;
                        if (update.update_id < legacyFloor) recoveryMenus.set(chat, update.update_id);
                    }
                }
                for (const update of updates) {
                    if (abort.signal.aborted) break;
                    const chat = update.callback_query?.message?.chat?.id || update.message?.chat?.id;
                    await controller.handle(update, api, botId, { silentRecovery: legacyFloor !== null && recoveryMenus.get(chat) !== update.update_id });
                }
                if (!abort.signal.aborted) cursor.finishBatch();
            } catch (error) {
                if (abort.signal.aborted) break;
                if (error.status === 409) {
                    onError(`[WARN] Telegram menu stopped for bot ${botId}: another update receiver is active. Run only one bot process.`);
                    return;
                }
                onError(`[WARN] Telegram menu polling failed for bot ${botId}${error.status ? ` (status ${error.status})` : ''}; retrying.`);
                await wait(Number.isFinite(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter * 1000 : 10000);
            }
        }
    });
    return { stop: () => abort.abort(), done: Promise.all(workers) };
};

module.exports = { createTelegramAPI, TelegramController, startTelegramControl, listView, detailView };
