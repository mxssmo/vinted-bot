const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const sendMessageToTelegram = async (message, photos, botConfig, { fetchImpl = fetch } = {}) => {
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
    const sendText = () => request('sendMessage', { text: message, parse_mode: 'HTML' });
    if (!selected.length) return sendText();
    try {
        if (selected.length === 1) {
            await request('sendPhoto', { photo: selected[0], caption: message, parse_mode: 'HTML' });
        } else {
            await request('sendMediaGroup', { media: selected.map((photo, index) => ({
                type: 'photo', media: photo,
                ...(index === 0 ? { caption: message, parse_mode: 'HTML' } : {})
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
