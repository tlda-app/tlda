import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/tlda/config.json'), 'utf8'));
const token = cfg.tokenRead;
const base = 'http://localhost:5176';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// === 8. MathJax in tour ===
await page.goto(`${base}/?doc=balancing-tour&token=${token}`);
await page.waitForTimeout(10000);
await page.screenshot({ path: path.join(DIR, '08-mathjax-tour.png') });
const mjx = await page.evaluate(() => document.querySelectorAll('mjx-container').length);
console.log(`8. MathJax tour — ${mjx} mjx-container elements`);

// === 9. Slides spatial canvas ===
await page.goto(`${base}/?doc=imagined-rand&token=${token}`);
await page.waitForTimeout(10000);
await page.screenshot({ path: path.join(DIR, '09-slides-spatial.png') });
console.log('9. Slides spatial');

// === 11. Highlighter strip ===
await page.goto(`${base}/?doc=balancing-tour&token=${token}`);
await page.waitForTimeout(8000);
const vp = page.viewportSize();
await page.mouse.move(vp.width - 14, vp.height / 2);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(DIR, '11-highlighter-strip.png') });
console.log('11. Highlighter strip');

// === 12. Dot annotations ===
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(DIR, '12-dot-collapsed.png') });
console.log('12. Annotations');

await browser.close();
console.log('\ntlda screenshots complete');
