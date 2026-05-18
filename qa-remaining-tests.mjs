import { chromium } from 'playwright';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5176/?token=${TOKEN}`;

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 2000, height: 900 });

  // ── F6: Preamble macro loading ──
  console.log('=== F6: Preamble macro ===');
  await page.goto(`${BASE}&doc=survival-draft`);
  await page.waitForTimeout(5000);
  
  const loaded = await page.evaluate(() => document.title);
  console.log('Page title:', loaded);
  
  await page.screenshot({ path: '/Users/skip/work/tlda/scratch/qa-f6-app-loaded.png' });

  // Count shapes to confirm app loaded
  const shapeCount = await page.evaluate(() => document.querySelectorAll('.tl-shape').length);
  console.log('Shape count:', shapeCount);

  // Press 'm' for math note
  await page.mouse.click(720, 350);
  await page.waitForTimeout(200);
  await page.keyboard.press('m');
  await page.waitForTimeout(300);
  await page.mouse.click(720, 350);
  await page.waitForTimeout(2000);
  
  await page.screenshot({ path: '/Users/skip/work/tlda/scratch/qa-f6-note-clicked.png' });

  // Type a macro
  await page.keyboard.type('$\\E[X]$');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/Users/skip/work/tlda/scratch/qa-f6-typing.png' });
  
  // Commit and screenshot
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '/Users/skip/work/tlda/scratch/qa-f6-rendered.png' });

  // ── F4: File drag ──
  console.log('\n=== F4: File drag ===');
  // Navigate fresh
  await page.goto(`${BASE}&doc=survival-draft`);
  await page.waitForTimeout(5000);

  const chatInfo = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-shape-type="fleet-chat"]'));
    const el = els.find(e => e.getBoundingClientRect().width > 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height - 50), w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('Fleet chat shape:', chatInfo);

  // Find textarea
  const taInfo = await page.evaluate(() => {
    const ta = Array.from(document.querySelectorAll('textarea')).find(t => {
      const r = t.getBoundingClientRect();
      return r.width > 0 && t.placeholder;
    });
    if (!ta) return null;
    const r = ta.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), placeholder: ta.placeholder };
  });
  console.log('Textarea:', taInfo);

  // Use the file upload tool - find the file input or drag handler in the shape
  const uploadResult = await page.evaluate(async () => {
    // Find the textarea that accepts drops
    const tas = Array.from(document.querySelectorAll('textarea'));
    const ta = tas.find(t => t.getBoundingClientRect().width > 0 && t.placeholder);
    if (!ta) return 'no textarea';
    
    // Create a file and dispatch drop event on it
    const file = new File(['# Test markdown\nDragged file content.'], 'dragged-file.md', { type: 'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    
    ta.focus();
    ta.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    ta.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    ta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    
    await new Promise(r => setTimeout(r, 3000));
    return `dropped on "${ta.placeholder}", value now: "${ta.value.slice(0, 100)}"`;
  });
  console.log('Upload result:', uploadResult);
  await page.screenshot({ path: '/Users/skip/work/tlda/scratch/qa-f4-after-drop.png' });

  // ── F2: PlaybackFrame resize ──
  console.log('\n=== F2: PlaybackFrame resize ===');
  await page.goto(`${BASE}&doc=survival-draft`);
  await page.waitForTimeout(5000);
  
  // Place frame
  await page.mouse.click(720, 350);
  await page.waitForTimeout(100);
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  await page.mouse.move(450, 120);
  await page.mouse.down();
  await page.mouse.move(830, 560);
  await page.mouse.up();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/Users/skip/work/tlda/scratch/qa-f2-frame-initial.png' });

  // Select recording
  const pickerItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pbf-picker-item')).map(el => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent?.trim().slice(0,30), x: Math.round(r.x + 15), y: Math.round(r.y + 8) };
    })
  );
  console.log('Recordings available:', pickerItems.length, pickerItems[0]);

  if (pickerItems.length > 0) {
    await page.mouse.click(pickerItems[0].x, pickerItems[0].y);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: '/Users/skip/work/tlda/scratch/qa-f2-loaded.png' });
  }

  // Get frame size
  const framePre = await page.evaluate(() => {
    const el = document.querySelector('[data-shape-type="playback-frame"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log('Frame pre-resize:', framePre);

  if (framePre) {
    // Click title bar to select
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.mouse.click(framePre.x + framePre.w/2, framePre.y + 12);
    await page.waitForTimeout(600);
    
    // Check selection
    const sel = await page.evaluate(() => window.__tldraw_editor__?.getSelectedShapeIds() || []);
    console.log('Selected via editor:', sel);

    // Drag bottom-right resize handle
    const cx = framePre.x + framePre.w;
    const cy = framePre.y + framePre.h;
    await page.mouse.move(cx - 4, cy - 4);
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/Users/skip/work/tlda/scratch/qa-f2-at-handle.png' });
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 100, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(800);

    const framePost = await page.evaluate(() => {
      const el = document.querySelector('[data-shape-type="playback-frame"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    console.log('Frame post-resize:', framePost);
    await page.screenshot({ path: '/Users/skip/work/tlda/scratch/qa-f2-after-resize.png' });
  }

  await browser.close();
  console.log('\nDone!');
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
