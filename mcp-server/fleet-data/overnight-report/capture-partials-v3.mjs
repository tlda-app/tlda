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

// === Dot Annotation ===
console.log('=== Dot Annotation ===');
await page.goto(`${base}/?doc=balancing-tour&token=${token}`);
await page.waitForTimeout(8000);

const dotResult = await page.evaluate(() => {
  const editor = window.__tldraw_editor__ || window.editor;
  if (!editor) return { error: 'no editor' };
  try {
    // Use tldraw's createShapeId
    const { createShapeId } = window;
    const tldraw = window.tldraw;
    let id;
    if (typeof createShapeId === 'function') {
      id = createShapeId();
    } else if (editor.createShapeId) {
      id = editor.createShapeId();
    } else {
      // Manual ID
      id = 'shape:dot-test-' + Date.now();
    }
    editor.createShape({
      id,
      type: 'dot-annotation',
      x: 500,
      y: 350,
      props: {
        color: '#22c55e',
        text: 'Test annotation — demonstrates the dot-annotation feature: collapsed dots in the margin expand to note cards on click.',
        title: 'Smoke Test',
      }
    });
    return { ok: true, id: String(id) };
  } catch (e) {
    return { error: e.message, stack: e.stack?.substring(0, 200) };
  }
});
console.log('Dot result:', dotResult);

await page.waitForTimeout(2000);

// Check if the dot was created
const dotExists = await page.evaluate(() => {
  const dots = document.querySelectorAll('[class*="dot-annotation"], [data-shape-type="dot-annotation"]');
  return { count: dots.length };
});
console.log('Dots in DOM:', dotExists);

await page.screenshot({ path: path.join(DIR, '12-dot-collapsed.png') });
console.log('Dot collapsed screenshot');

// Click the dot
if (dotResult.ok) {
  await page.mouse.click(500, 350);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(DIR, '12-dot-expanded.png') });
  console.log('Dot expanded screenshot');
}

// === Highlighter Drag on a color DOT (not tool) ===
console.log('\n=== Highlighter Drag ===');
// Hover right edge to show strip
const vp = page.viewportSize();
await page.mouse.move(vp.width - 14, vp.height / 2);
await page.waitForTimeout(1500);

// Target a .hl-strip-dot (color dot, not tool)
const colorDot = await page.evaluate(() => {
  const dots = document.querySelectorAll('.hl-strip-dot');
  if (!dots.length) return null;
  const r = dots[0].getBoundingClientRect();
  return { x: r.x + r.width/2, y: r.y + r.height/2, cls: dots[0].className };
});
console.log('Color dot:', colorDot);

if (colorDot) {
  await page.mouse.move(colorDot.x, colorDot.y);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  // Drag downward slowly
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(colorDot.x, colorDot.y + i * 4, { steps: 2 });
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(DIR, '11-highlighter-drag.png') });
  await page.mouse.up();
  console.log('Drag screenshot saved');
}

await browser.close();
console.log('\nDone');
