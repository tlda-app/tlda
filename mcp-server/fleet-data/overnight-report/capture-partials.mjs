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

// === 1. MathJax Tour — Navigate to a page with math ===
console.log('=== MathJax Tour ===');
await page.goto(`${base}/?doc=balancing-tour&token=${token}`);
await page.waitForTimeout(8000);

// Click on camera bookmark to navigate (try "ACT II" or "THE SOLVER")
const bookmarks = await page.evaluate(() => {
  const els = document.querySelectorAll('[class*="bookmark"], [class*="camera"], a, button');
  return Array.from(els).map(e => ({ text: e.textContent?.trim()?.substring(0, 50), tag: e.tagName, cls: e.className?.substring(0, 50) })).filter(e => e.text);
});
console.log('Bookmarks found:', bookmarks.slice(0, 10));

// Try clicking "ACT II — THE SOLVER" bookmark
for (const text of ['ACT II', 'THE SOLVER', 'SOLVER', 'dispersion', 'solver']) {
  const el = await page.$(`text=${text}`);
  if (el) {
    console.log(`Clicking bookmark: ${text}`);
    await el.click();
    await page.waitForTimeout(3000);
    break;
  }
}

// Wait for MathJax to render
await page.waitForTimeout(5000);

const mjxCount = await page.evaluate(() => document.querySelectorAll('mjx-container').length);
console.log(`MathJax containers: ${mjxCount}`);

// If still 0, try navigating to an iframe with math
if (mjxCount === 0) {
  // Check for iframes (html-page shapes)
  const iframes = await page.evaluate(() => {
    const frames = document.querySelectorAll('iframe');
    return Array.from(frames).map(f => ({ src: f.src?.substring(0, 100), w: f.width, h: f.height }));
  });
  console.log('Iframes:', iframes);

  // Check inside iframes for math
  for (const frame of page.frames()) {
    const mjxInFrame = await frame.evaluate(() => document.querySelectorAll('mjx-container').length).catch(() => 0);
    if (mjxInFrame > 0) {
      console.log(`Found ${mjxInFrame} mjx-container in iframe`);
      break;
    }
  }
}

await page.screenshot({ path: path.join(DIR, '08-mathjax-tour.png') });
console.log('MathJax screenshot saved');

// === 2. Highlighter Drag Slider ===
console.log('\n=== Highlighter Drag ===');
await page.goto(`${base}/?doc=balancing-tour&token=${token}`);
await page.waitForTimeout(8000);

const vp = page.viewportSize();
// Hover right edge to reveal strip
await page.mouse.move(vp.width - 14, vp.height / 2);
await page.waitForTimeout(1500);

// Find the color dots — they're on the right edge
// The dots are at specific y positions. Try to find them by checking for colored elements
const stripInfo = await page.evaluate(() => {
  // Look for the highlighter strip element
  const strip = document.querySelector('[class*="highlight-strip"], [class*="highlighter"], [class*="hl-strip"]');
  if (strip) return { found: true, cls: strip.className, rect: strip.getBoundingClientRect() };
  // Fallback: check for colored circles near right edge
  const els = document.elementsFromPoint(window.innerWidth - 14, window.innerHeight / 3);
  return { found: false, els: els.map(e => ({ tag: e.tagName, cls: e.className?.substring(0, 50) })) };
});
console.log('Strip info:', stripInfo);

// Try mousedown on a color dot position and drag
// The red dot is typically near the top of the strip
const dotY = 180; // approximate y for first color dot
await page.mouse.move(vp.width - 14, dotY);
await page.waitForTimeout(500);
await page.mouse.down();
await page.waitForTimeout(200);
// Drag down slowly
for (let i = 0; i < 10; i++) {
  await page.mouse.move(vp.width - 14, dotY + i * 8, { steps: 2 });
  await page.waitForTimeout(50);
}
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(DIR, '11-highlighter-drag.png') });
await page.mouse.up();
console.log('Highlighter drag screenshot saved');

// === 3. Dot Annotations ===
console.log('\n=== Dot Annotations ===');
await page.goto(`${base}/?doc=balancing-tour&token=${token}`);
await page.waitForTimeout(8000);

// Create a dot annotation via tldraw editor API
const dotCreated = await page.evaluate(() => {
  const editor = window.__tldraw_editor__ || window.editor;
  if (!editor) return { error: 'no editor found', keys: Object.keys(window).filter(k => k.includes('editor') || k.includes('tldraw')) };

  try {
    // Create a note-dot shape
    const id = 'shape:dot-test-' + Date.now();
    editor.createShape({
      id,
      type: 'note-dot',
      x: 400,
      y: 300,
      props: {
        color: '#22c55e',
        text: 'This is a test annotation created by the smoke test. It demonstrates the dot-annotation feature: collapsed dots in the margin that expand to note cards on click.',
        title: 'Test Annotation',
      }
    });
    return { ok: true, id };
  } catch (e) {
    return { error: e.message };
  }
});
console.log('Dot creation:', dotCreated);

await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(DIR, '12-dot-collapsed.png') });
console.log('Dot collapsed screenshot saved');

// Try to click the dot to expand it
if (dotCreated.ok) {
  // Click near where we created the dot
  await page.mouse.click(400, 300);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(DIR, '12-dot-expanded.png') });
  console.log('Dot expanded screenshot saved');
}

await browser.close();
console.log('\nPartial screenshots complete');
