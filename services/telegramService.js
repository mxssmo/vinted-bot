const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { load } = require('cheerio');
const plainText = html => load(html, null, false).text();

const sendMessageToTelegram = async (message, photos, botConfig, { fetchImpl = fetch, itemUrl } = {}) => {
    const request = async (method, payload) => {
        const response = await fetchImpl(`https://api.telegram.org/bot${botConfig.botToken}/${method}`, {
            method: 'POST', signal: AbortSignal.timeout(30000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: botConfig.chatId, ...payload })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
            // Do not include response descriptions or request URLs in logged errors.
            const error = new Error('Telegram rejected delivery');
            error.status = Number(data.error_code || response.status);
            error.destinationFailure = [401, 403, 429].includes(error.status) ||
                /chat not found|chat_id|not enough rights|thread not found|topic_closed|migrat/i.test(data.description || '');
            error.permanent = [400, 413, 422].includes(error.status) && !error.destinationFailure;
            error.retryAfter = Number(data.parameters?.retry_after);
            throw error;
        }
    };

    const selected = [...new Set((photos || []).filter(photo => typeof photo === 'string' && photo))].slice(0, 10);
    const keyboard = itemUrl ? { reply_markup: { inline_keyboard: [[{ text: 'Open on Vinted ↗', url: itemUrl }]] } } : {};
    const sendText = async () => {
        const text = plainText(message);
        if (text.length <= 4096) return request('sendMessage', { text: message, parse_mode: 'HTML', ...keyboard });
        // Exceptionally large attribute lists need multiple text messages.
        // Plain text preserves every value without splitting HTML entities/tags.
        let remaining = text;
        while (remaining.length) {
            let end = Math.min(4096, remaining.length);
            if (end < remaining.length) {
                const newline = remaining.lastIndexOf('\n', end - 1);
                if (newline >= 0) end = newline + 1;
                else if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
            }
            const chunk = remaining.slice(0, end);
            remaining = remaining.slice(end);
            await request('sendMessage', { text: chunk, ...(!remaining ? keyboard : {}), link_preview_options: { is_disabled: true } });
        }
    };
    // Keep all attributes rather than letting a long photo caption be rejected.
    if (!selected.length || plainText(message).length > 1024) return sendText();
    try {
        if (selected.length === 1) {
            await request('sendPhoto', { photo: selected[0], caption: message, parse_mode: 'HTML', ...keyboard });
        } else {
            // Albums do not support inline keyboards. Keep the listing accessible
            // in their caption without sending an extra message per item.
            const escapedUrl = itemUrl && String(itemUrl).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const caption = itemUrl ? `${message}\n\n🔗 <a href="${escapedUrl}">Open on Vinted ↗</a>` : message;
            if (plainText(caption).length > 1024) return sendText();
            await request('sendMediaGroup', { media: selected.map((photo, index) => ({
                type: 'photo', media: photo,
                ...(index === 0 ? { caption, parse_mode: 'HTML' } : {})
            })) });
        }
    } catch (error) {
        // Only an explicit rejection is safe to fall back from. A timeout may
        // mean Telegram accepted the photo, so leave it for the normal retry.
        if (!error.permanent) throw error;
        await sendText();
    }
};

module.exports = { sendMessageToTelegram };
