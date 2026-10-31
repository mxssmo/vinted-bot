// Each bot can manage multiple URLs through /searches in Telegram.
// Tokens and chat IDs belong in .env. Search settings live in SQLite.
const botConfigs = [
    {
        botToken: process.env.TELEGRAM_BOT_TOKEN_1,
        chatId: process.env.TELEGRAM_CHAT_ID_1,
        priceLimit: 60,
        urls: []
    },
    {
        botToken: process.env.TELEGRAM_BOT_TOKEN_2,
        chatId: process.env.TELEGRAM_CHAT_ID_2,
        priceLimit: 50,
        urls: []
    }
].filter(config => config.botToken || config.chatId);

if (!botConfigs.length) {
    throw new Error('Configure TELEGRAM_BOT_TOKEN_1 and TELEGRAM_CHAT_ID_1 in .env before starting.');
}

module.exports = botConfigs;
