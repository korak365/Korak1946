// Apify SDK + Crawlee Playwright crawler starter for Instagram Reels (Playwright required)
import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, RequestList } from 'crawlee';

await Actor.init();

const {
    startUrls = ['https://www.instagram.com/explore/tags/music/'],
    maxRequestsPerCrawl = 200,
    authMethod = 'none',
    cookieString = '',
    username = '',
    password = '',
    dedupe = true,
} = (await Actor.getInput()) ?? {};

// NOTE: If scraping Instagram at scale, use Apify Proxy and rotate sessions
const proxyConfiguration = await Actor.createProxyConfiguration();

const requestList = await RequestList.open('start-urls', startUrls);

// Use Key-Value store for dedupe (store seen audio IDs)
const kvStore = await Actor.openKeyValueStore();
let seenAudioIds = (await kvStore.getValue('seenAudioIds')) || [];
const seenSet = new Set(seenAudioIds);

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    launchContext: {
        // Headless by default; set headless: false to debug
        launchOptions: { headless: true },
    },
    requestList,
    async preNavigationHooks({ request, page, log }) {
        // Authentication placeholder: cookie injection or login flow.
        if (authMethod === 'cookie' && cookieString) {
            // Common Instagram cookie: sessionid=...
            log.info('Setting cookie for domain .instagram.com');
            const [cookiePairs] = [cookieString];
            // Parse cookie string into cookies array for Playwright
            const cookies = cookiePairs.split(';').map(c => {
                const [name, ...v] = c.trim().split('=');
                return { name, value: v.join('='), domain: '.instagram.com', path: '/' };
            });
            await page.context().addCookies(cookies);
        } else if (authMethod === 'credentials' && username && password) {
            // Placeholder: implement a login flow before navigation if you want credentials-based auth.
            log.warning('Credentials auth chosen but no login flow is implemented in this starter. Implement secure login in preNavigationHooks.');
        }
    },
    async requestHandler({ page, request, enqueueLinks, log }) {
        log.info('Visiting', { url: request.url });

        // For feed pages, scroll to load Reels (infinite scroll). Adjust iterations/timeouts as needed.
        const AUTO_SCROLL_TIMES = 4;
        for (let i = 0; i < AUTO_SCROLL_TIMES; i++) {
            await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight);
            });
            await page.waitForTimeout(1000 + Math.random() * 1500);
        }

        // Enqueue links discovered on page (feeds/profile/hashtag -> individual reels)
        // We try to capture reel and audio links. Instagram structure may vary; adapt selectors per page.
        await enqueueLinks({
            selector: 'a[href*="/reel/"], a[href*="/audio/"], a[href*="/sound/"]',
            globs: ['**/reel/**', '**/audio/**', '**/sound/**'],
            userData: { type: 'candidate' },
        });

        // If the current page is a reel or audio page, extract metadata
        // Heuristic: /reel/ or /audio/ path in URL
        const url = new URL(request.url);
        const path = url.pathname || '';

        if (path.includes('/reel/') || path.includes('/audio/') || path.includes('/sound/')) {
            // Extract audio metadata where available
            // Example selectors — Instagram UI changes frequently; tune for target pages
            const audioAnchor = await page.$('a[href*="/audio/"], a[href*="/sound/"]');
            const audioUrl = audioAnchor ? await audioAnchor.getAttribute('href') : null;
            let audioId = null;
            if (audioUrl) {
                try {
                    const au = new URL(audioUrl, 'https://www.instagram.com');
                    audioId = au.pathname.split('/').filter(Boolean).pop();
                } catch (e) {
                    audioId = null;
                }
            }

            // Audio name/title
            const audioName =
                (await page.$eval('a[href*="/audio/"]', (el) => el.textContent?.trim()).catch(() => null)) ||
                (await page.$eval('h1', (el) => el.textContent?.trim()).catch(() => null)) ||
                null;

            // Try to find a usage estimate (UI might show "Used in X reels" or similar)
            let usageEstimate = null;
            const usageText = await page.$eval('div', (el) => {
                const t = el.innerText || '';
                return /used in .*reel/i.test(t) ? t.match(/used in .*reel/i)[0] : null;
            }).catch(() => null);
            if (usageText) usageEstimate = usageText;

            // Thumbnail / preview image
            const thumbnail =
                (await page.$eval('meta[property="og:image"]', (el) => el.getAttribute('content')).catch(() => null)) ||
                null;

            // Author and post URL
            const author =
                (await page.$eval('header a[href*="/"]', (el) => el.textContent?.trim()).catch(() => null)) ||
                null;
            const postUrl = request.loadedUrl;

            // Timestamp (if available)
            const timestamp =
                (await page.$eval('time', (el) => el.getAttribute('datetime')).catch(() => null)) || null;

            // Build item
            const item = {
                audioId,
                audioName,
                usageEstimate,
                thumbnail,
                author,
                postUrl,
                timestamp,
                crawledAt: new Date().toISOString(),
            };

            // Deduplicate by audioId if requested
            const alreadySeen = dedupe && audioId && seenSet.has(audioId);
            if (alreadySeen) {
                log.info('Audio already seen, skipping push', { audioId });
            } else {
                // Push to dataset
                await Dataset.pushData(item);
                log.info('Pushed audio item', { audioId, audioName });

                if (dedupe && audioId) {
                    seenSet.add(audioId);
                    // Persist seen set after each new item for safety
                    await kvStore.setValue('seenAudioIds', Array.from(seenSet));
                }
            }
        }
    },
    failedRequestHandler: async ({ request, log }) => {
        log.error('Request failed', { url: request.url });
    },
});

await crawler.run();

// Persist seen IDs at exit
if (seenSet.size) {
    await kvStore.setValue('seenAudioIds', Array.from(seenSet));
}

await Actor.exit();