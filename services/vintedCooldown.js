const BLOCK_DELAY = 30 * 60 * 1000;
const RATE_LIMIT_DELAY = 3 * 60 * 1000;

class VintedCooldown {
    constructor(now = Date.now) {
        this.now = now;
        this.until = new Map();
    }

    retryAt(domain) {
        const until = this.until.get(domain) || 0;
        return until > this.now() ? until : 0;
    }

    assertReady(domain) {
        const retryAt = this.until.get(domain) || 0;
        if (retryAt > this.now()) {
            const error = new Error(`Vinted ${domain} cooldown: retry in ${Math.ceil((retryAt - this.now()) / 1000)}s`);
            error.code = 'VINTED_COOLDOWN';
            error.retryAt = retryAt;
            error.nonRetryable = true;
            throw error;
        }
        this.until.delete(domain);
    }

    block(domain, duration) {
        this.until.set(domain, Math.max(this.until.get(domain) || 0, this.now() + duration));
        this.assertReady(domain);
    }

    checkResponse(domain, response) {
        if (![403, 429].includes(response.status)) return;
        const header = response.headers.get('retry-after');
        let duration;
        if (header && /^\d+$/.test(header.trim())) duration = Number(header) * 1000;
        else if (header) duration = Date.parse(header) - this.now();
        if (!Number.isFinite(duration) || duration <= 0) duration = RATE_LIMIT_DELAY;
        // A block warrants a longer pause; never shorten a server's requested delay.
        if (response.status === 403) duration = Math.max(BLOCK_DELAY, duration);
        this.block(domain, duration);
    }
}

const vintedCooldown = new VintedCooldown();
module.exports = { VintedCooldown, vintedCooldown, BLOCK_DELAY };
