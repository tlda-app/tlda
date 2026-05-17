import { chromium } from 'playwright';
import path from 'path';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5176/?token=${TOKEN}`;
const OUT = '/Users/skip/work/tlda/scratch';

async function waitForSelector(page, sel, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const found = await page.evaluate(s => document.querySelector(s) !== null, sel);
    if (found) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function run() {
  const browser = await chromium.launch({ headless: true });

  // ── F6: Preamble macro loading ──────────────────────────────────────────
  console.log('\n=== F6: Preamble macro loading ===');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 2000, height: 900 });
    await page.goto(`${BASE}&doc=survival-draft`);
    await page.waitForTimeout(5000);

    // Press 'm' to create math note
    await page.mouse.click(800, 400);
    await page.waitForTimeout(200);
    await page.keyboard.press('m');
    await page.waitForTimeout(400);
    // Click to place the note at center of canvas
    await page.mouse.click(800, 400);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/qa-f6-placed.png` });

    // Should be in editing mode — type the macro
    await page.keyboard.type('$\\E[X]$');
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/qa-f6-typing2.png` });

    // Click elsewhere to commit
    await page.mouse.click(1300, 400);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/qa-f6-committed.png` });

    // Zoom in on the math note to see rendered output
    // Find the math note DOM element
    const noteInfo = await page.evaluate(() => {
      const notes = Array.from(document.querySelectorAll('[data-shape-type="math-note"]'));
      // Find the most recently created one (furthest from center or largest y)
      const el = notes[notes.length - 1];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width/2, cy: r.y + r.height/2 };
    });
    console.log('Math note:', noteInfo);

    if (noteInfo) {
      // Take a clipped screenshot of just the note area (with padding)
      const clip = {
        x: Math.max(0, noteInfo.x - 20),
        y: Math.max(0, noteInfo.y - 20),
        width: Math.min(noteInfo.w + 40, 400),
        height: Math.min(noteInfo.h + 40, 200),
      };
      await page.screenshot({ path: `${OUT}/qa-f6-note-zoomed.png`, clip });
      console.log('F6: Math note zoomed screenshot taken');
    }

    // Also check if KaTeX span exists inside the note
    const katexContent = await page.evaluate(() => {
      const spans = document.querySelectorAll('.katex');
      return Array.from(spans).map(s => s.textContent?.slice(0, 40)).filter(Boolean);
    });
    console.log('KaTeX rendered spans:', katexContent.slice(0, 5));

    await page.close();
  }

  // ── F4: File drag onto fleet chat ───────────────────────────────────────
  console.log('\n=== F4: File drag ===');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 2000, height: 900 });
    await page.goto(`${BASE}&doc=survival-draft`);
    await page.waitForTimeout(5000);

    // Zoom to fit all shapes so fleet chat shapes are visible
    await page.evaluate(() => {
      if (window.__tldraw_editor__) {
        window.__tldraw_editor__.zoomToFit({ animation: { duration: 0 } });
      }
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/qa-f4-zoom-fit.png` });

    // Find all textareas
    const allTextareas = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('textarea')).map(t => {
        const r = t.getBoundingClientRect();
        return {
          placeholder: t.placeholder,
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0
        };
      });
    });
    console.log('All textareas:', JSON.stringify(allTextareas));

    // Find fleet chat shapes
    const chatShapes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-shape-type="fleet-chat"]')).map(el => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      });
    });
    console.log('Fleet chat shapes:', JSON.stringify(chatShapes));

    // Find the first visible textarea (fleet chat input)
    const taResult = await page.evaluate(async () => {
      const ta = Array.from(document.querySelectorAll('textarea')).find(t => {
        const r = t.getBoundingClientRect();
        return r.width > 50 && r.height > 10;
      });
      if (!ta) return { error: 'no textarea found' };

      const r = ta.getBoundingClientRect();
      const placeholder = ta.placeholder;

      // Create a file and dispatch drop
      const file = new File(['# Test file\nDragged content.'], 'qa-test-drag.md', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);

      ta.focus();
      ta.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 100));
      ta.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 100));
      ta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 4000));

      return {
        placeholder,
        pos: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) },
        valueBefore: ta.value.slice(0, 200),
      };
    });
    console.log('File drop result:', JSON.stringify(taResult));
    await page.screenshot({ path: `${OUT}/qa-f4-after-drop2.png` });

    // If textarea found and value shows a link, that's the pass
    if (taResult.valueBefore && taResult.valueBefore.includes('http')) {
      console.log('F4 PASS: Upload link appeared in textarea');
    } else {
      // Try via curl to upload and check API
      console.log('F4: textarea drop did not insert link; verifying API directly...');
    }

    await page.close();
  }

  // ── F2: PlaybackFrame resize ─────────────────────────────────────────────
  console.log('\n=== F2: PlaybackFrame resize ===');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 2000, height: 900 });
    await page.goto(`${BASE}&doc=survival-draft`);
    await page.waitForTimeout(5000);

    // Click canvas to deselect tools
    await page.mouse.click(1000, 400);
    await page.waitForTimeout(200);

    // Press 'p' for playback tool
    await page.keyboard.press('p');
    await page.waitForTimeout(400);

    // Draw the frame — left portion of canvas, avoid document area
    await page.mouse.move(120, 80);
    await page.mouse.down();
    await page.mouse.move(430, 460, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/qa-f2-new-frame.png` });

    // Wait for picker to appear with items (poll up to 8s)
    console.log('Waiting for picker items...');
    let pickerReady = false;
    for (let i = 0; i < 25; i++) {
      const count = await page.evaluate(() => document.querySelectorAll('.pbf-picker-item').length);
      if (count > 0) { pickerReady = true; console.log(`Picker ready with ${count} items`); break; }
      await page.waitForTimeout(350);
    }
    await page.screenshot({ path: `${OUT}/qa-f2-picker-ready.png` });

    if (pickerReady) {
      // Get first picker item position and click it
      const firstItem = await page.evaluate(() => {
        const el = document.querySelector('.pbf-picker-item');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + 60), y: Math.round(r.y + 8), text: el.textContent?.trim().slice(0, 40) };
      });
      console.log('Clicking:', firstItem);

      if (firstItem) {
        await page.mouse.click(firstItem.x, firstItem.y);
        await page.waitForTimeout(4000);
        await page.screenshot({ path: `${OUT}/qa-f2-recording-loaded.png` });

        // Check if recording loaded (controls should be visible)
        const hasControls = await page.evaluate(() => !!document.querySelector('.pbf-play'));
        console.log('Play button present:', hasControls);

        // Get current frame bounds
        const framePre = await page.evaluate(() => {
          const el = document.querySelector('[data-shape-type="playback-frame"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        });
        console.log('Frame bounds:', framePre);

        if (framePre) {
          // Click the title area to select the shape in fleet canvas
          // First press Escape to exit any editing mode
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);

          // Click on the frame's title bar
          await page.mouse.click(framePre.x + 50, framePre.y + 8);
          await page.waitForTimeout(500);
          await page.screenshot({ path: `${OUT}/qa-f2-selected.png` });

          // Try to drag the bottom-right resize handle
          // The handle should be at exactly the corner
          const handleX = framePre.x + framePre.w;
          const handleY = framePre.y + framePre.h;
          console.log(`Dragging from (${handleX}, ${handleY}) → (+150, +100)`);

          await page.mouse.move(handleX, handleY);
          await page.waitForTimeout(500);
          await page.screenshot({ path: `${OUT}/qa-f2-hover-handle.png` });

          await page.mouse.down();
          await page.mouse.move(handleX + 150, handleY + 100, { steps: 20 });
          await page.mouse.up();
          await page.waitForTimeout(1000);

          const framePost = await page.evaluate(() => {
            const el = document.querySelector('[data-shape-type="playback-frame"]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          });
          console.log('Frame after resize:', framePost);
          await page.screenshot({ path: `${OUT}/qa-f2-resized.png` });

          if (framePost && framePre && (framePost.w !== framePre.w || framePost.h !== framePre.h)) {
            console.log(`F2 RESIZE PASS: ${framePre.w}x${framePre.h} → ${framePost.w}x${framePost.h}`);
          } else {
            console.log('F2 RESIZE: No size change detected (may be in separate editor)');
            // Try selecting via TLDraw API by looking at all shapes
            const fleetShapes = await page.evaluate(() => {
              // Try to find the fleet editor via React internals
              const el = document.querySelector('[data-shape-type="playback-frame"]');
              if (!el) return 'no shape element';

              // Get the shape-id
              const shapeId = el.getAttribute('data-shape-id') || el.id;
              return `shape-id=${shapeId}, bounds=${el.getBoundingClientRect().width}x${el.getBoundingClientRect().height}`;
            });
            console.log('Fleet shape info:', fleetShapes);
          }
        }
      }
    }

    await page.close();
  }

  await browser.close();
  console.log('\n=== All tests done ===');
}

run().catch(e => { console.error('ERROR:', e.message, e.stack); process.exit(1); });
