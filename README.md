# Vinted → Telegram

**Save a Vinted search. Get new matches in Telegram. Manage your searches from the chat.**

A personal alert bot for watching Vinted catalog URLs. Paste a search link into Telegram, give it a name, and let the bot check for unseen listings while it is running.

No dashboard, public server, Docker, or PM2 is required. Run it on your computer with Node.js, or on your own server.

## What it does

- Watches multiple search URLs in each Telegram bot.
- Selects up to **five newest unseen matches per search per cycle**, from the first results page only.
- Lets you add, replace, pause, resume, and delete searches in Telegram.
- Sends listing photos, price, size, condition, and a link to Vinted.
- Adds the public **starting shipping price** and **listing age** when available.
- Remembers searches and delivery history across restarts using SQLite.
- Creates daily database backups and exposes health information through `/status`.

### Example alert

A listing photo arrives with a caption like this:

```text
🏷️ Linen shirt

💰 Price: 12.00 EUR
🚚 Shipping from: 4,39 €
📏 Size: L
📦 Status: Ottime
🕒 Listed: 2 min fa

🔗 View on Vinted
```

*Illustrative values. Shipping and listing age are omitted when unavailable. Vinted's listing details may appear in the language of the selected marketplace.*

## Quick start

### 1. Install the project

You need **Node.js 22.13 or newer**, npm, Git, and a Telegram account.

```sh
git clone https://github.com/mxssmo/vinted-bot.git
cd vinted-bot
npm ci
cp .env.example .env
```

The shell examples use macOS/Linux syntax. If `.env` already exists, edit it instead of replacing it. Run the following commands from the project directory.

### 2. Create a Telegram bot

1. Open the verified [@BotFather](https://t.me/BotFather) account in Telegram.
2. Send `/newbot` and follow its prompts.
3. Copy the token it provides into `.env` as `TELEGRAM_BOT_TOKEN_1`.
4. Open your new bot's chat and send `/start`.

Your token controls the bot. Keep it in `.env`; do not paste it into issues, screenshots, or shared commands. Telegram's [official tutorial](https://core.telegram.org/bots/tutorial) explains bot creation in more detail.

### 3. Set your chat ID

Set `TELEGRAM_CHAT_ID_1` in `.env` to the numeric ID of your private chat with the bot. For a personal setup, this is also your Telegram user ID.

<details>
<summary>Find your chat ID using your own bot</summary>

Do this **before starting the application**, with the token already saved in `.env`. Send `/start` to your new bot, then run:

```sh
node --env-file=.env <<'NODE'
(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN_1;
  if (!token) throw new Error('Missing token');

  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeout: 0, allowed_updates: ['message'] }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json();
  if (!data.ok) throw new Error('Telegram rejected the request');

  const ids = [...new Set((data.result || [])
    .filter(update => update.message?.chat?.type === 'private')
    .map(update => update.message.chat.id))];

  console.log(ids.length ? ids.join('\n') : 'No chat found. Send /start to your bot and try again.');
})().catch(() => {
  console.error('Could not read chat IDs. Check your token and connection.');
  process.exitCode = 1;
});
NODE
```

The command reads the token from `.env` and prints only private-chat IDs. If more than one ID appears, use the one belonging to your own chat. Do not run a separate update receiver while the application is running.

</details>

Your first bot needs these two values filled in:

```dotenv
TELEGRAM_BOT_TOKEN_1=your_botfather_token
TELEGRAM_CHAT_ID_1=your_numeric_chat_id
```

Leave both second-bot fields blank unless you want another bot.

### 4. Run it

```sh
npm start
```

Keep this terminal open. Stop the bot with **Ctrl+C** when you are finished.

### 5. Add your first search

1. Open Vinted and select the brands, sizes, conditions, and other filters you want.
2. Copy the **catalog search URL** from the address bar.
3. Send `/searches` to your Telegram bot.
4. Tap **＋ Add URL**, paste the link, and enter a short name.

The search is saved immediately and becomes eligible for checking on the next cycle. You do **not** need to restart the program after changing URLs in Telegram.

## Manage searches in Telegram

### Commands

| Command | What it does |
| --- | --- |
| `/searches` | Opens saved searches and the **Add URL** button. |
| `/status` | Shows search counts, recent checks, queued alerts, cooldowns, and backup health. |
| `/cancel` | Cancels an add/replace operation and returns to the search list. |

The Telegram command menu contains these commands. **Tap a saved search inside `/searches` to reveal its management buttons.**

### Search controls

| Button | Behavior |
| --- | --- |
| **＋ Add URL** | Adds a separate search alongside the existing ones. |
| **Replace URL** | Replaces the selected search's URL and keeps its name. |
| **Pause** | Stops checking that search and holds its pending alerts. Other searches continue. |
| **Resume** | Checks the newest page again on the next cycle. It does not crawl older pages. |
| **Delete** | Asks for confirmation, then removes the search. Sent-item history is retained. |

Each bot has its **own** search list. Adding a new URL never deletes an old one automatically. Search names can contain 1–60 characters; unfinished input conversations expire after 15 minutes.

The program must be running to respond. Pausing a search does not stop the terminal process. An alert already being sent may still finish, and a listing matching another active search may still be delivered.

## How alerts are selected

1. Read each active search's **first page**, ordered newest first, with up to 96 listings.
2. Apply the bot's price limit and skip items already delivered or queued.
3. Prepare up to **five new matching items per search**.
4. Fetch optional shipping/listing-age details and send the alerts to Telegram.

The default wait is **three minutes after a cycle finishes**. Requests and deliveries add to the time between checks; it is not a fixed three-minute schedule.

The five-item limit is **per search**, not per bot. Four active searches can select up to 20 new alerts in a cycle. If more unseen matches remain on the newest page, later cycles can select the next five even if no new listings appeared.

### Stopping and restarting

Search settings and delivery history stay on disk. Restarting does not reset them: paused searches stay paused, deleted searches stay deleted, and successfully delivered items remain skipped.

Before sending pending alerts, the bot checks current results. **An old queued item can retry only if it still matches an active search on that cycle's newest page.** Failed checks leave those alerts held. The bot never crawls older pages to catch up after a break.

There is no age cutoff. A quiet search's newest page can still contain older listings.

## Configuration

Tokens and chat IDs belong in `.env`. The supplied release starts with **no saved search URLs**; add them through Telegram.

| Setting | Purpose | Default |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN_1` | Token from BotFather for the first bot. | Required |
| `TELEGRAM_CHAT_ID_1` | Destination chat for the first bot. | Required |
| `TELEGRAM_BOT_TOKEN_2` | Token for an optional second bot. | Disabled when both second-bot fields are blank |
| `TELEGRAM_CHAT_ID_2` | Destination chat for the second bot. | — |
| `TELEGRAM_ADMIN_USER_ID` | Explicit owner for a group chat or another administrator. | Private destination's user ID |
| `DELIVERY_DB_PATH` | SQLite database file. | `data/deliveries.sqlite` |
| `DELIVERY_BACKUP_DIR` | Daily snapshot directory. | `backups/` beside the database |

Each configured bot needs both a token and a chat ID. Both bots can send to the same person while maintaining separate searches.

**Price limits:** edit `priceLimit` in [`config/botConfigs.js`](config/botConfigs.js), then restart. The supplied limits are 60 for bot 1 and 50 for bot 2. They apply to all searches in that bot; there is no Telegram price-editing button. Amounts are compared numerically without currency conversion.

For the standard private-chat setup, only the user matching the configured chat ID can manage searches. Group destinations require an explicit administrator. Every command and button checks both the sender and destination chat.

Existing process environment variables take precedence over `.env`. Defaults are resolved from the working directory, so launch from the project folder. Status timestamps use **Europe/Rome**; backup filenames use **UTC dates**.

## Your data and backups

Runtime data is local and ignored by Git:

```text
data/
├── deliveries.sqlite          # Searches, delivery history, and menu state
├── deliveries.sqlite-wal      # May exist while SQLite is running
├── deliveries.sqlite-shm      # May exist while SQLite is running
└── backups/
    └── deliveries-YYYY-MM-DD.sqlite
```

Keep the database when upgrading or moving computers. Stop the bot before copying its live database, or use a consistent snapshot from `backups/`. A fresh clone does not include your searches or delivery history. Back up `.env` separately; database snapshots do not contain bot tokens.

### Automatic backups

At startup, the bot creates a snapshot if one does not already exist for the current UTC date. While running, it checks hourly for a new date and keeps the **latest seven daily snapshots**.

Snapshots include committed WAL data and are checked before publication. A failed backup leaves previous snapshots intact, logs a warning, and lets the bot continue. `/status` shows the last successful backup and any backup warning.

No backups run while the bot is stopped. Snapshots are daily, not a backup after every edit, and live on the same disk unless you configure another location.

### Restore a snapshot

1. Stop the bot.
2. Copy a chosen backup to a **new, unused filename**, for example `data/restored.sqlite`.
3. Set this in `.env`:

   ```dotenv
   DELIVERY_DB_PATH=data/restored.sqlite
   ```

4. Restart and check `/searches` and `/status`.

Keep the original database until the restore is verified. Do not overwrite a live database or copy its `-wal`/`-shm` files onto a snapshot.

## What the extra listing details mean

**Shipping from** is the starting amount shown on the public item page using an anonymous session. It is **not a checkout quote** for your account, destination, or chosen carrier. Promotions can show zero shipping. The item price, buyer-protection fee, and total item price are never treated as shipping costs.

**Listed** is Vinted's displayed listing age, such as `2 min fa`, at the time the page was read. A genuine listing timestamp can be used when available; a photo timestamp is never substituted. Missing dates are hidden.

Both values come from the **same optional item-page request**, with a ten-second timeout, for selected new alerts. If the page is unavailable, the alert can still send without those fields. Blocked detail requests back off separately from catalog searches. Previously queued or delivered captions are not rewritten.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The bot exits with a configuration error. | Fill in a complete token/chat-ID pair in `.env` and confirm Node.js is 22.13+. |
| `/searches` does not respond. | Confirm the terminal process is running, the sender/chat IDs match configuration, and you sent `/start` to the bot. |
| Only `/searches`, `/status`, and `/cancel` appear in the command menu. | This is expected. Open `/searches`, then tap a saved search to see its buttons. |
| A saved search sends no alerts. | Check that it is active, the first page contains unseen matches below the price limit, and `/status` shows no fetch errors or cooldown. |
| Shipping or listing age is missing. | The public page may lack the field, be blocked, or have an unrecognised layout. Ordinary alerts still work. |
| `/status` shows held alerts. | They need a fresh newest-page match from an active search before they can send. |
| Telegram reports a conflicting update receiver. | Stop the other process using that token. Run one instance per bot token. |
| The terminal mentions an existing webhook. | The bot leaves it intact and disables its menu receiver. Use a dedicated bot without another webhook integration. |
| The terminal reports a Vinted cooldown. | Wait for it to expire. Catalog 403 responses pause that domain for at least 30 minutes; rate limits follow the server's retry delay. |
| A backup fails. | Check disk space and permissions for the backup directory; keep an external copy of valuable snapshots. |

**Laptop sleep:** an actual system sleep normally pauses the process; it resumes when the computer wakes. A locked or dark screen does not necessarily mean the computer is asleep. Telegram commands cannot start a stopped process.

## Development

```sh
npm test
```

Tests use mocked network requests and temporary SQLite databases. They do not contact Vinted or send Telegram messages.

| Location | Responsibility |
| --- | --- |
| `index.js` | Startup, polling cycles, delivery, and shutdown. |
| `config/botConfigs.js` | Bot definitions and price limits. |
| `services/searchStore.js` | Saved searches, pause state, and fresh-page delivery eligibility. |
| `services/telegramControl.js` | Telegram commands, buttons, and owner checks. |
| `services/itemPageService.js` | Optional shipping and listing-age extraction. |
| `services/deliveryService.js` | Persistent alert queue, retries, and delivery history. |
| `services/backupService.js` | Daily SQLite snapshots and retention. |
| `test/` | Selection, delivery, menu, recovery, backup, and parsing tests. |

This is an **unofficial Vinted integration**. Catalog endpoints and item-page layouts can change. It checks listings and sends alerts; it does not buy items or guarantee that every matching listing will be captured.

The package declares the **ISC** license in [`package.json`](package.json).
