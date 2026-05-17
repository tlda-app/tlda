import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/tlda/config.json'), 'utf8'));
const token = cfg.tokenRead;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.goto(`http://localhost:5176/?doc=balancing-tour&token=${token}`);
await page.waitForTimeout(8000);

// Look for dot-annotation shapes
const dots = await page.evaluate(() => {
  const els = document.querySelectorAll('[class*="dot-annotation"], [data-shape-type="dot-annotation"]');
  return { count: els.length, classes: Array.from(els).map(e => e.className?.substring(0, 80)) };
});
console.log('Dots:', dots);

// Try finding the shape at (500, 350) — might need to pan camera
// Take screenshot of current view first
await page.screenshot({ path: path.join(DIR, '12-dot-collapsed.png') });
console.log('Collapsed screenshot');

// Click at (500, 350) to try expanding the dot
await page.mouse.click(500, 350);
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(DIR, '12-dot-expanded.png') });
console.log('Expanded screenshot');

// Check what's visible
const visible = await page.evaluate(() => {
  const cards = document.querySelectorAll('[class*="note-card"], [class*="annotation-card"], [class*="dot-expanded"]');
  return { count: cards.length, classes: Array.from(cards).map(e => e.className?.substring(0, 80)) };
});
console.log('Cards:', visible);

await browser.close();
