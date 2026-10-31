const { vintedCooldown } = require('./vintedCooldown');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const cookies = new Map();
const COOKIE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const cookieTimestamps = new Map();

const RELIABLE_USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));


const fetchCookie = async (domain = 'it', { fetchImpl = fetch, wait = delay, cooldown = vintedCooldown } = {}) => {
    try {
        cooldown.assertReady(domain);

        // Check if we have a non-expired cookie
        const timestamp = cookieTimestamps.get(domain);
        if (timestamp && (Date.now() - timestamp < COOKIE_EXPIRY)) {
            const existingCookie = cookies.get(domain);
            if (existingCookie) {
                console.log(`[INFO] Using cached cookie for ${domain}`);
                return existingCookie;
            }
        }

        const userAgent = RELIABLE_USER_AGENTS[Math.floor(Math.random() * RELIABLE_USER_AGENTS.length)];
        console.log('[DEBUG] Fetching with User-Agent:', userAgent);

        await wait(Math.floor(Math.random() * 1000) + 500);

        const referrers = [
            'https://www.google.com/',
            'https://www.bing.com/',
            'https://www.ecosia.org/'
        ];
        const randomReferrer = referrers[Math.floor(Math.random() * referrers.length)];

        const response = await fetchImpl(`https://www.vinted.${domain}`, {
            headers: {
                'user-agent': userAgent,
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9,it;q=0.8',
                'accept-encoding': 'gzip, deflate, br',
                'connection': 'keep-alive',
                'referer': randomReferrer,
                'sec-ch-ua': '"Google Chrome";v="131", "Not(A:Brand";v="8", "Chromium";v="131"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1',
                'cache-control': 'max-age=0'
            },
            redirect: 'follow',
            follow: 5,
            signal: AbortSignal.timeout(15000)
        });

        // Log response status for debugging
        console.log(`[DEBUG] Cookie fetch response status: ${response.status}`);


        cooldown.checkResponse(domain, response);
        if (!response.ok) throw new Error(`Cookie request returned ${response.status}`);

        let allCookies = response.headers.raw()['set-cookie'];

        if (!allCookies || allCookies.length === 0) {

            console.log('[WARN] No cookies in initial response, checking for redirects...');
            // Try to extract cookies from redirect
            if (response.status >= 300 && response.status < 400) {
                console.log('[DEBUG] Following redirect to get cookies');
                const locationUrl = response.headers.get('location');
                if (locationUrl) {
                    // Add slight delay before following redirect
                    await wait(1000);
                    const redirectResponse = await fetchImpl(locationUrl, {
                        headers: {
                            'user-agent': userAgent,
                            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                            'accept-language': 'en-US,en;q=0.9,it;q=0.8',
                            'connection': 'keep-alive'
                        },
                        signal: AbortSignal.timeout(15000)
                    });
                    cooldown.checkResponse(domain, redirectResponse);
                    const redirectCookies = redirectResponse.headers.raw()['set-cookie'];
                    if (redirectCookies && redirectCookies.length > 0) {
                        console.log('[DEBUG] Found cookies in redirect');
                        allCookies = redirectCookies;
                    }
                }
            }

            if (!allCookies || allCookies.length === 0) {
                throw new Error('No cookies received');
            }
        }
        console.log(`[DEBUG] Received ${allCookies.length} cookies`);
        // console.log('[DEBUG] === ALL COOKIES ===');
        //     allCookies.forEach((cookie, index) => {
        //         console.log(`[DEBUG] Cookie ${index + 1}:`, cookie);
        //     });
        //     console.log('[DEBUG] === END OF COOKIES ===');


        // Only an access token can authenticate catalogue requests.
        const foundCookie = allCookies.find(cookie =>
            cookie.startsWith('access_token_web=') &&
            !/Max-Age=(?:-1|0)(?:;|$)/i.test(cookie) &&
            cookie.split(';')[0] !== 'access_token_web='
        );
        if (!foundCookie) throw new Error('No valid access_token_web cookie received');
        const tokenValue = foundCookie.split(';')[0].slice('access_token_web='.length);
        if (tokenValue) {
            cookies.set(domain, tokenValue);
            cookieTimestamps.set(domain, Date.now());
            console.log(`[INFO] Successfully fetched cookie for ${domain}`);
            return tokenValue;
        } else {
            throw new Error('Invalid cookie format');
        }
    } catch (error) {
        console.error('[ERROR] Failed to fetch cookie:', error.message);
        throw error;
    }
};

module.exports = {
    cookies,
    fetchCookie,
    RELIABLE_USER_AGENTS
};