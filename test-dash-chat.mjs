import { chromium } from 'playwright';

const browser = await chromium.launch();
// Mobile viewport
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto('http://localhost:5199');
await page.waitForSelector('.msg-thread', { timeout: 5000 });
await page.screenshot({ path: '/tmp/dash-mobile-before.png', fullPage: true });

// Desktop too
const page2 = await browser.newPage({ viewport: { width: 800, height: 900 } });
await page2.goto('http://localhost:5199');
await page2.waitForSelector('.msg-thread', { timeout: 5000 });
await page2.screenshot({ path: '/tmp/dash-desktop-before.png', fullPage: true });

await browser.close();
console.log('Mobile: /tmp/dash-mobile-before.png');
console.log('Desktop: /tmp/dash-desktop-before.png');
