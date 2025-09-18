// screenshot.js
const { chromium } = require('playwright');

// Usage:
// node screenshot.js <url> [outPath] [width] [height] [dpr] [mode]
// Example:
// node screenshot.js "https://example.com" shot.png 1920 1080 3 full

(async () => {
  const [
    ,,
    url,
    outPath = 'screenshot.png',
    w = '1920',
    h = '1080',
    dpr = '3',
    mode = 'full' // 'full' or 'viewport'
  ] = process.argv;

  if (!url) {
    console.error('Usage: node screenshot.js <url> [outPath] [width] [height] [dpr] [mode]');
    process.exit(1);
  }

  const width = parseInt(w, 10);
  const height = parseInt(h, 10);
  const deviceScaleFactor = parseFloat(dpr);

  // Launch your system Chrome (no big downloads)
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true
  });

  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
    locale: 'en-GB'
  });

  const page = await context.newPage();

  // Load and settle
  await page.goto(url, { waitUntil: 'networkidle' });

  // Wait for webfonts, then freeze animations for pixel-stable shots
  try { if (page.evaluateHandle) await page.evaluate(() => document.fonts?.ready); } catch { /* ignore */ }
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });

  // Take the shot
  await page.screenshot({
    path: outPath,
    fullPage: mode.toLowerCase() === 'full'
  });

  await browser.close();
  console.log(`Saved → ${outPath}`);
})();
