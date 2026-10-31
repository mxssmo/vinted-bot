const { normalizeListings } = require('./listingService');
const { vintedCooldown, BLOCK_DELAY } = require('./vintedCooldown');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { cookies, fetchCookie, RELIABLE_USER_AGENTS } = require('./cookieService');
const { parseVintedURL } = require('../utils/urlParser');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const search = async (url, maxRetries = 3, { fetchImpl = fetch, cookieFetcher = fetchCookie, wait = delay, cooldown = vintedCooldown } = {}) => {
    console.log('[DEBUG] Starting search...');
    const { validURL, domain, querystring } = parseVintedURL(url);
    console.log(`[DEBUG] ParsedURL - Domain: ${domain}, Valid: ${validURL}`);

    if (!validURL) {
        console.error(`[ERROR] Invalid URL: ${url}`);
        return [];
    }

    cooldown.assertReady(domain);
    let refreshedCookie = false;
    let retryCount = 0;
    let backoffDelay = 2000; // Start with 2 seconds, will increase exponentially

    while (retryCount < maxRetries) {
        try {
            cooldown.assertReady(domain);
            // Reuse the cached token unless authentication fails
            console.log('[DEBUG] Getting session token...');
            const currentCookie = await cookieFetcher(domain, { cooldown });

            // Add jitter to delay to appear more human-like
            await wait(Math.floor(Math.random() * 1000) + backoffDelay);

            // Use reliable user agent
            const userAgent = RELIABLE_USER_AGENTS[Math.floor(Math.random() * RELIABLE_USER_AGENTS.length)];

            // Create browser-like headers
            const headers = {
                'Authorization': `Bearer ${currentCookie}`,
                'Cookie': `access_token_web=${currentCookie}`,
                'Platform': 'web',
                'x-next-app': 'marketplace-web',
                'Locale': domain === 'it' ? 'it-IT' : 'en-GB',
                'user-agent': userAgent,
                'accept': 'application/json, text/plain, */*',
                'accept-language': 'en-US,en;q=0.9,it;q=0.8',
                'accept-encoding': 'gzip, deflate, br',
                'referer': `https://www.vinted.${domain}/`,
                'origin': `https://www.vinted.${domain}`,
                'connection': 'keep-alive',
                'sec-ch-ua': '"Google Chrome";v="131", "Not(A:Brand";v="8", "Chromium";v="131"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
                'pragma': 'no-cache',
                'cache-control': 'no-cache',
                'x-requested-with': 'XMLHttpRequest'
            };

            // Add unique request ID and timestamp to appear more legitimate
            const requestId = Math.random().toString(36).substring(2, 15);
            const apiUrl = `https://api.vinted.${domain}/svc-catalogue/items?${querystring}`;

            console.log(`[DEBUG] Fetching from API with request ID: ${requestId}`);

            const response = await fetchImpl(apiUrl, {
                headers,
                signal: AbortSignal.timeout(30000)
            });

            console.log(`[DEBUG] API response status: ${response.status}`);

            cooldown.checkResponse(domain, response);
            if (response.status === 401) {
                cookies.delete(domain);
                if (refreshedCookie) cooldown.block(domain, 3 * 60 * 1000);
                refreshedCookie = true;
                console.log('[INFO] Authentication expired; refreshing cookie once');
                retryCount++;
                backoffDelay *= 2;
                continue;
            }

            if (response.status === 404) {
                const error = new Error(`Catalog endpoint not found: ${new URL(apiUrl).origin}${new URL(apiUrl).pathname}`);
                error.nonRetryable = true;
                throw error;
            }

            if (!response.ok) {
                throw new Error(`Server returned ${response.status}: ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                console.warn('[WARN] Response is not JSON:', contentType);
                const text = await response.text();
                console.debug('[DEBUG] Response preview:', text.substring(0, 200));
                if (text.includes('captcha') || text.includes('robot') || text.includes('suspicious')) {
                    cooldown.block(domain, BLOCK_DELAY);
                }
                throw new Error('Invalid content type received');
            }

            const data = await response.json();
            if (!Array.isArray(data.items)) throw new Error('Catalog response does not contain an items array');
            data.items = normalizeListings(data.items, domain);
            console.log(`[INFO] Successfully fetched ${data.items.length} items`);
            return data;

        } catch (error) {
            if (error.nonRetryable) throw error;
            console.error(`[ERROR] Search attempt ${retryCount + 1} failed:`, error.message);

            if (error.name === 'AbortError' ||
                error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT' ||
                error.message.includes('network') ||
                error.message.includes('socket')) {

                console.log('[INFO] Network error, retrying after backoff...');
                await wait(backoffDelay);
                backoffDelay *= 1.5; // Gentler backoff for network issues
            } else {
                // For other errors, use exponential backoff
                await wait(backoffDelay);
                backoffDelay *= 2;
            }

            retryCount++;
            if (retryCount >= maxRetries) {
                throw new Error(`Failed after ${maxRetries} attempts: ${error.message}`);
            }
        }
    }
    throw new Error(`Failed after ${maxRetries} attempts: authentication or rate limit retries exhausted`);
};

module.exports = {
    search
};