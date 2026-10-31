# Vinted Telegram alerts

Polls saved Vinted searches and sends matching listings to Telegram.

## Setup

Requires Node.js 22.13 or newer (for built-in SQLite).

1. Run `npm ci`.
2. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN_1` and `TELEGRAM_CHAT_ID_1`. Use your BotFather token and the destination Telegram chat ID. Leave the second bot blank unless you need it. If `.env` already exists, update its values instead.
3. Adjust the bot-wide price limits in `config/botConfigs.js` if needed. The release includes no personal search URLs; add your searches through Telegram.
4. Run `npm start`, open your bot in Telegram, and send `/searches` to add URLs.

`.env` is loaded from the working directory, including when running `node index.js` under PM2. Existing process environment variables take precedence. Never commit `.env` or tokens. If a token is accidentally committed, revoke it through BotFather and update `.env`; deleting it from the latest file alone does not remove it from older commits. Configure `.env` separately on the deployment VM and upgrade its Node runtime before deploying this change. Restart PM2 with `--update-env` if credentials are supplied through its environment.

## Manage searches in Telegram

With the bot running, send `/searches` to either of your Telegram bots. Each bot manages its own URLs:

- **Add URL:** paste a Vinted catalog link, then enter a short name.
- **List:** choose any saved search to see its URL and status.
- **Replace URL:** paste a replacement for that search; other URLs stay as they are.
- **Pause / Resume:** pause stops checks and holds that search's queued alerts. Resume checks only the newest page on the next cycle and selects up to five unseen matches. It does not release older queued items unless they reappear in an active search's newest results.
- **Delete:** confirm removal of a search. Delivery history is kept to avoid duplicate alerts.
- `/cancel` cancels adding or replacing a URL and returns to the list.
- `/status` shows this bot’s active/paused search counts, latest successful check and attempt, eligible/held queued alerts, failed alerts, search errors, Vinted/Telegram cooldowns, and last backup. You can also tap **Status** in the search menu.

The existing bot price limit applies to every URL in that bot. There is no price-editing menu. The program must be running for buttons and commands to respond. Search settings, input sessions, and processed-update offsets persist in the same SQLite database as delivery history. Input sessions expire after 15 minutes. Existing URLs receive names such as “Search 1”; tap them to see the URL. A new search can be given any name of 1–60 characters.

Changes take effect without restarting. Pause, replace, and delete are rechecked before queueing fetched results and before each delivery. An alert already being sent can still complete. A listing matched by another active search can still be delivered. URLs and their enabled state are imported from JavaScript only once per bot/chat; deleted URLs will not return after a restart. Keep bot credentials and destinations in `.env`, and bot-wide price limits in `config/botConfigs.js`. Older queued alerts without a recorded search source wait until they are rediscovered in an active search's newest page.

For private-chat destinations, only the Telegram user matching the configured chat ID can manage searches. For another administrator or a group destination, explicitly set `TELEGRAM_ADMIN_USER_ID` in `.env` (or `adminUserId` in that bot's config). Both the sender and destination chat are checked on every command and button action. Tokens remain in `.env` and are never stored in search records.

Menu updates use Telegram long polling independently from Vinted searches. Run only one instance of this program per bot token. An existing webhook is left intact and disables the menu, with a terminal warning; another active update receiver also stops menu polling. No public website or server URL is needed. If a menu response fails, send `/searches` again to refresh it; changes already saved will not be duplicated.

Telegram update positions also record when the last update was received. After 48 hours without received updates, the bot resynchronizes with Telegram before polling again, so commands can still work if Telegram restarts its update numbering after a longer inactive period. Normal duplicate-update protection remains in place. When upgrading an older database without this timestamp, any ambiguous older pending inputs reopen the search menu rather than replaying add/delete operations; repeat the desired action in the refreshed menu. Expired input conversations are cleared for that bot during recovery, while saved searches and delivery history stay intact.

## Automatic database backups

The bot creates a consistent SQLite snapshot at startup if today's snapshot does not already exist, then checks hourly for a new UTC date. It keeps the latest seven daily snapshots in `data/backups/`, with names such as `deliveries-2026-10-31.sqlite`. With a custom `DELIVERY_DB_PATH`, the default backup directory is `backups/` beside that database; override it with `DELIVERY_BACKUP_DIR` if needed. Use a separate backup directory for each database.

Backups include saved searches, pause/deletion settings, delivery history, menu state, and check status. They use SQLite's `VACUUM INTO` to capture committed WAL data, are integrity-checked, and are published only after completion. Backup files are readable only by your user. A failed backup logs a warning and leaves the bot running and previous backups intact. No backups are made while the program is stopped; an overdue backup is made the next time it starts. `/status` shows the last successful backup and warns about a failed attempt. Status times are shown in Europe/Rome.

These are local backups on the same disk. Keep a copy elsewhere if you want protection against disk loss. Tokens in `.env` are not included. Daily snapshots can be up to a day behind the live database; this is not a backup after every menu edit.

To restore, stop the bot first. Copy a chosen snapshot to a **new database filename** (for example, `data/restored.sqlite`), set `DELIVERY_DB_PATH=data/restored.sqlite` in `.env`, and restart. Do not overwrite the live database or copy its `-wal`/`-shm` files onto the snapshot. Keep the original database until you have verified the restored searches and history. Commands and checks continue normally after restoration.

## Listing dates

New alerts use the listing-age value displayed by Vinted (for example, `2 min fa` or `3 giorni fa`) from the item page's `item-attributes-upload_date` field. It is read during the same page request as shipping, without another request. This is Vinted's age label at lookup time, not an invented exact posting timestamp. If a genuine `created_at_ts` is present it remains a fallback; photo timestamps are never treated as listing dates. If neither source is available, the Listed row is omitted. Previously queued or sent messages are not rewritten.

## Starting shipping prices

New alerts include `Shipping from: …` when the public item page displays a starting shipping amount. The catalog response does not include this amount, so the bot reads the dedicated `item-shipping-banner-price` element on the item page for up to five newly selected unseen listings per search. The item price, buyer-protection fee, and total item price are never used as shipping estimates.

The displayed amount comes from Vinted's public page using an anonymous session. It is a starting price, not a quote for your logged-in account, destination, or selected carrier; promotions can also produce a zero starting price. Unavailable or unrecognised amounts are omitted. A page lookup times out after ten seconds and falls back to the original alert without optional shipping/date details. Blocked/rate-limited item-page lookups back off separately so catalog searches continue. There are no extra requests for items already sent or queued. Existing saved alert payloads are not rewritten.

## Malformed listings

Listings are validated individually. Records with invalid IDs, missing titles, unusable prices, or invalid listing URLs are skipped with a warning; other results still proceed. A missing URL can be reconstructed from the listing ID. Malformed optional size, condition, timestamp, and photo fields use safe defaults or are omitted. Alert preparation failures do not consume the five-item limit. Database write failures are reported as errors instead of being treated as bad listings.

## Vinted request cooldowns

Homepage and catalog requests share a cooldown per Vinted country domain. HTTP 403 responses pause that domain for at least 30 minutes. HTTP 429 responses pause it for the `Retry-After` interval (seconds or an HTTP date), or three minutes if the header is missing or invalid. Longer server-requested pauses are preserved. A catalog 401 refreshes the session once; another 401 pauses the domain for three minutes. A detected CAPTCHA response also pauses the domain for 30 minutes.

During a pause, searches for that domain make no network requests. Other Vinted domains and deliveries confirmed by successful newest-page checks can continue. Searches resume on the first polling cycle after the cooldown expires. These Vinted cooldowns live in memory and reset when the bot restarts; Telegram delivery cooldowns are stored in SQLite separately.

## Delivery history

Queued messages and successful delivery records are stored in `data/deliveries.sqlite` (override with `DELIVERY_DB_PATH`). Keep this directory on persistent storage and include it in backups. History is scoped by Telegram bot ID and chat ID, so rotating a token preserves history and separate destinations each receive their alerts.

Messages are queued before sending and marked delivered only after Telegram reports success. Temporary item failures remain queued for later cycles, including after a restart, while later alerts can proceed. Each cycle checks the newest results before sending anything; a queued alert can retry only if its item still matches an active search on that cycle’s newest page. If Vinted is unavailable, those alerts remain held. Telegram requests time out after 30 seconds. Rate limits pause the whole destination for Telegram's requested retry interval; authentication, permission, or chat failures pause it for three minutes. These pauses persist across restarts and all affected messages remain queued.

Single photos use `sendPhoto`; multiple photos use an album; alerts without photos use text. If Telegram explicitly rejects a photo request as invalid, the bot tries the listing as text. It does not immediately fall back after a timeout or server error, because the original request may have succeeded. If the final request is permanently rejected, the item is retained in SQLite with `failed_at` set, logged by item ID, and excluded from automatic retries so it cannot block subsequent alerts. Such items are not marked delivered and are not automatically selected again. Existing databases migrate automatically without clearing delivery history.

Delivery is at least once: if Telegram accepts a message but the response is lost, or the process exits before saving success, a retry may duplicate it. History is retained indefinitely to avoid re-alerting old listings. Each search fetches only the first page of newest results (up to 96 listings), even if its saved URL specifies another page or sort order. At most five of the newest unseen matching listings per search per cycle are queued. Listings already sent or queued for the destination do not count toward that limit. Remaining unseen matches can be picked up on later cycles if they are still on the first page. Failed deliveries already in the queue retry separately. This applies both at startup and while running. The bot never fetches older pages to catch up after a break. There is no age cutoff, so quiet searches can still return older listings on their newest page. Queued alerts that leave the newest page remain held instead of being sent as an old backlog. Their records are retained, so delivery history is not lost. Current-page membership is intentionally kept only in memory and is rebuilt after every restart and at the start of each cycle.


The default polling delay is three minutes after each cycle completes. Stop the process using your process manager or Ctrl+C.

## Tests

Run `npm test`. Tests use temporary SQLite databases and mocked delivery functions; they do not contact Vinted or Telegram.
