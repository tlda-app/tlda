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

// === 1. MathJax — check inside the iframe ===
console.log('=== MathJax ===');
await page.goto(`${base}/?doc=balancing-tour&token=${token}`);
await page.waitForTimeout(8000);

// Navigate to ACT III which might have more math
const act3 = await page.$('text=ACT III');
if (act3) {
  await act3.click();
  await page.waitForTimeout(5000);
}

// Check all frames for mjx-container
for (const frame of page.frames()) {
  const url = frame.url();
  const mjx = await frame.evaluate(() => {
    return {
      mjx: document.querySelectorAll('mjx-container').length,
      math: document.querySelectorAll('.MathJax, .katex, [class*="math"]').length,
      title: document.title,
    };
  }).catch(() => null);
  if (mjx && (mjx.mjx > 0 || mjx.math > 0)) {
    console.log(`Frame ${url.substring(0, 80)}: ${JSON.stringify(mjx)}`);
  }
}

// Also check parent
const parentMjx = await page.evaluate(() => ({
  mjx: document.querySelectorAll('mjx-container').length,
  katex: document.querySelectorAll('.katex').length,
}));
console.log('Parent page:', parentMjx);

await page.screenshot({ path: path.join(DIR, '08-mathjax-tour.png') });
console.log('MathJax screenshot saved');

// === 3. Dot Annotations — correct shape type 'dot-annotation' ===
console.log('\n=== Dot Annotations ===');

// List available shape types
const shapeTypes = await page.evaluate(() => {
  const editor = window.__tldraw_editor__ || window.editor;
  if (!editor) return { error: 'no editor' };
  // Get registered shape utils
  const utils = editor.shapeUtils;
  if (utils instanceof Map) return { types: [...utils.keys()] };
  return { types: Object.keys(utils || {}), hasEditor: true };
});
console.log('Shape types:', shapeTypes);

const dotResult = await page.evaluate(() => {
  const editor = window.__tldraw_editor__ || window.editor;
  if (!editor) return { error: 'no editor' };
  try {
    const id = editor.createShapeId();
    editor.createShape({
      id,
      type: 'dot-annotation',
      x: 500,
      y: 400,
      props: {
        color: '#22c55e',
        text: 'Test annotation from smoke test — demonstrates collapsed dot → expanded note card feature.',
        title: 'Smoke Test Note',
      }
    });
    return { ok: true, id: id.toString() };
  } catch (e) {
    return { error: e.message };
  }
});
console.log('Dot creation:', dotResult);

await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(DIR, '12-dot-collapsed.png') });

if (dotResult.ok) {
  // Try clicking where the dot should be
  await page.mouse.click(500, 400);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(DIR, '12-dot-expanded.png') });
}

// === 2. Highlighter Drag — target an actual color dot ===
console.log('\n=== Highlighter Drag ===');

// Get the strip element's position and dot positions
const stripRect = await page.evaluate(() => {
  const strip = document.querySelector('.hl-strip');
  if (!strip) return null;
  const dots = strip.querySelectorAll('.hl-dot, [class*="dot"], button, [role="button"]');
  const dotRects = Array.from(dots).map(d => {
    const r = d.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2, cls: d.className, text: d.textContent?.trim() };
  });
  const r = strip.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, dots: dotRects };
});
console.log('Strip rect:', stripRect);

if (stripRect && stripRect.dots?.length > 0) {
  // Use the first dot
  const dot = stripRect.dots[0];
  console.log('Targeting dot:', dot);
  await page.mouse.move(dot.x, dot.y);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  // Drag down
  for (let i = 0; i < 15; i++) {
    await page.mouse.move(dot.x, dot.y + i * 5, { steps: 2 });
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(DIR, '11-highlighter-drag.png') });
  await page.mouse.up();
} else if (stripRect) {
  // Hover the strip center and try dragging from there
  const cx = stripRect.x + stripRect.w / 2;
  const cy = stripRect.y + stripRect.h * 0.2; // near top
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(500);
  await page.mouse.down();
  for (let i = 0; i < 15; i++) {
    await page.mouse.move(cx, cy + i * 5, { steps: 2 });
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(DIR, '11-highlighter-drag.png') });
  await page.mouse.up();
}
console.log('Highlighter drag screenshot saved');

await browser.close();
console.log('\nDone');
