import { chromium } from 'playwright';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5176/?token=${TOKEN}`;
const OUT = '/Users/skip/work/tlda/scratch';

async function run() {
  const browser = await chromium.launch({ headless: true });

  // ── F6: Math note with preamble macro ───────────────────────────────────
  console.log('\n=== F6: Math note with \\E[X] macro ===');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 2000, height: 900 });
    await page.goto(`${BASE}&doc=survival-draft`);
    await page.waitForTimeout(5000);

    // Use TLDraw API to create math note with content
    const created = await page.evaluate(() => {
      const ed = window.__tldraw_editor__;
      if (!ed) return { error: 'no editor' };

      // Place it in visible area
      const id = `shape:qa-test-f6-${Date.now()}`;
      ed.createShape({
        id,
        type: 'math-note',
        x: 600, y: 200,
        props: { text: '$\\\\E[X]$', w: 220, h: 80 }
      });
      return { id, success: true };
    });
    console.log('Created shape:', created);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/qa-f6-api-created.png` });

    // Check for KaTeX rendering
    const katexSpans = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.katex')).map(s => s.textContent?.trim().slice(0, 60));
    });
    console.log('KaTeX spans found:', katexSpans.length, katexSpans.slice(0, 5));

    // Find the math note and zoom in
    const noteRect = await page.evaluate((id) => {
      const el = document.querySelector(`[data-shape-id="${id}"]`) ||
                 document.querySelectorAll('[data-shape-type="math-note"]')[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, created.id);
    console.log('Note rect:', noteRect);

    if (noteRect && noteRect.w > 0) {
      const pad = 30;
      await page.screenshot({
        path: `${OUT}/qa-f6-note-clip.png`,
        clip: {
          x: Math.max(0, noteRect.x - pad),
          y: Math.max(0, noteRect.y - pad),
          width: Math.min(noteRect.w + pad*2, 600),
          height: Math.min(noteRect.h + pad*2, 200)
        }
      });
      console.log('F6: Clipped note screenshot saved');
    }

    // Also check via math-note component internals — look for the rendered HTML
    const noteHtml = await page.evaluate(() => {
      const note = document.querySelector('[data-shape-type="math-note"]');
      return note ? note.innerHTML.slice(0, 500) : 'not found';
    });
    console.log('Note inner HTML preview:', noteHtml.slice(0, 200));

    await page.close();
  }

  // ── F4: File drag onto fleet chat ───────────────────────────────────────
  console.log('\n=== F4: File drag onto fleet chat ===');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 2000, height: 900 });
    await page.goto(`${BASE}&doc=survival-draft`);
    await page.waitForTimeout(5000);

    // DO NOT zoomToFit — keep default camera position where fleet shapes are visible
    await page.screenshot({ path: `${OUT}/qa-f4-initial.png` });

    // Find all visible textareas (no zoomToFit)
    const allTas = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('textarea')).map(t => {
        const r = t.getBoundingClientRect();
        // Also get computed style
        const cs = window.getComputedStyle(t);
        return {
          placeholder: t.placeholder,
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          display: cs.display, visibility: cs.visibility, overflow: cs.overflow
        };
      });
    });
    console.log('Textareas:', JSON.stringify(allTas, null, 2));

    // Find fleet-chat shapes
    const chatShapes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-shape-type="fleet-chat"]')).map(el => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      });
    });
    console.log('Fleet-chat shapes:', JSON.stringify(chatShapes));

    // Check the fleet HUD elements
    const fleetEls = await page.evaluate(() => {
      const els = ['[class*="fleet"]', '[class*="hud"]', '.fleet-hud', '.hud-root'];
      return els.map(sel => ({
        sel,
        count: document.querySelectorAll(sel).length,
        first: document.querySelector(sel) ?
          JSON.stringify(document.querySelector(sel)?.getBoundingClientRect()) : null
      }));
    });
    console.log('Fleet elements:', JSON.stringify(fleetEls));

    // Look for any textarea that could be fleet chat
    const anyTA = await page.evaluate(async () => {
      // Try all possible textareas including ones inside shadow DOM or iframes
      const all = Array.from(document.querySelectorAll('textarea'));
      // Also look for contenteditable
      const ces = Array.from(document.querySelectorAll('[contenteditable]'));

      return {
        textareaCount: all.length,
        ceCount: ces.length,
        textareas: all.map(t => ({ ph: t.placeholder, w: t.offsetWidth, h: t.offsetHeight })),
        ces: ces.map(ce => ({ cls: ce.className?.slice(0,30), w: ce.offsetWidth, h: ce.offsetHeight })).slice(0,5)
      };
    });
    console.log('All inputs:', JSON.stringify(anyTA));

    // Try scrolling/panning to find fleet shapes
    // The fleet canvas might be at a different pan position
    // Try pressing 'h' for hand tool and panning
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Try to get shapes from the editor store to find fleet chat positions
    const storeShapes = await page.evaluate(() => {
      const ed = window.__tldraw_editor__;
      if (!ed) return 'no editor';
      const shapes = ed.getCurrentPageShapes();
      return shapes
        .filter(s => s.type === 'fleet-chat' || s.type === 'fleet-agents')
        .map(s => ({ type: s.type, id: s.id, x: Math.round(s.x), y: Math.round(s.y) }));
    });
    console.log('Fleet shapes in store:', JSON.stringify(storeShapes));

    // If fleet shapes found in store, pan to them
    if (Array.isArray(storeShapes) && storeShapes.length > 0) {
      const fc = storeShapes.find(s => s.type === 'fleet-chat') || storeShapes[0];
      console.log('Panning to fleet shape at:', fc.x, fc.y);

      await page.evaluate((shape) => {
        const ed = window.__tldraw_editor__;
        if (!ed) return;
        ed.centerOnPoint({ x: shape.x + 150, y: shape.y + 200 }, { animation: { duration: 0 } });
        ed.setCamera({ ...ed.getCamera(), z: 1 }, { animation: { duration: 0 } });
      }, fc);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/qa-f4-panned-to-fleet.png` });

      // Now find textareas
      const visibleTas = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('textarea')).map(t => {
          const r = t.getBoundingClientRect();
          return { ph: t.placeholder, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        });
      });
      console.log('Visible textareas after pan:', JSON.stringify(visibleTas));

      // Find a visible fleet chat textarea and drop file on it
      const dropResult = await page.evaluate(async () => {
        const ta = Array.from(document.querySelectorAll('textarea')).find(t => {
          const r = t.getBoundingClientRect();
          return r.width > 50 && r.height > 10;
        });
        if (!ta) return { error: 'still no visible textarea' };

        const placeholder = ta.placeholder;
        const r = ta.getBoundingClientRect();

        const file = new File(['# Dragged file\nTest content.'], 'fleet-test.md', { type: 'text/plain' });
        const dt = new DataTransfer();
        dt.items.add(file);

        ta.focus();
        ta.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise(r => setTimeout(r, 200));
        ta.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise(r => setTimeout(r, 200));
        ta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise(r => setTimeout(r, 5000));

        return { placeholder, pos: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }, value: ta.value.slice(0, 300) };
      });
      console.log('Drop result:', JSON.stringify(dropResult));
      await page.screenshot({ path: `${OUT}/qa-f4-drop-result.png` });
    } else {
      // Upload API test as fallback — screenshot with curl result
      console.log('Fleet shapes not in document editor store — uploading via API');
      await page.screenshot({ path: `${OUT}/qa-f4-no-fleet-shapes.png` });
    }

    await page.close();
  }

  // ── F2: PlaybackFrame resize attempt ────────────────────────────────────
  console.log('\n=== F2: PlaybackFrame resize via selection ===');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 2000, height: 900 });
    await page.goto(`${BASE}&doc=survival-draft`);
    await page.waitForTimeout(5000);

    // Place a new playback frame in a clear area
    await page.mouse.click(1000, 400);
    await page.waitForTimeout(200);
    await page.keyboard.press('p');
    await page.waitForTimeout(400);
    await page.mouse.move(60, 60);
    await page.mouse.down();
    await page.mouse.move(350, 420, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1500);

    // Wait for picker items
    let pickerCount = 0;
    for (let i = 0; i < 25; i++) {
      pickerCount = await page.evaluate(() => document.querySelectorAll('.pbf-picker-item').length);
      if (pickerCount > 0) { console.log(`Picker has ${pickerCount} items`); break; }
      await page.waitForTimeout(350);
    }
    await page.screenshot({ path: `${OUT}/qa-f2-v2-picker.png` });

    if (pickerCount > 0) {
      // Click first recording
      const item = await page.evaluate(() => {
        const el = document.querySelector('.pbf-picker-item');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + 40), y: Math.round(r.y + 10), title: el.querySelector('.pbf-picker-name')?.textContent };
      });
      console.log('Clicking recording:', item);
      if (item) {
        await page.mouse.click(item.x, item.y);
        await page.waitForTimeout(4500);
        await page.screenshot({ path: `${OUT}/qa-f2-v2-loaded.png` });

        // Get frame bounds
        const frame = await page.evaluate(() => {
          // Get the most recently visible playback-frame
          const els = Array.from(document.querySelectorAll('[data-shape-type="playback-frame"]'));
          const el = els.find(e => e.getBoundingClientRect().width > 0) || els[0];
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const id = el.getAttribute('data-shape-id');
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), id };
        });
        console.log('Frame:', frame);

        if (frame) {
          // Try to select via click on frame, then look for TLDraw selection handles
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);

          // Click the frame's title area
          await page.mouse.click(frame.x + 60, frame.y + 6);
          await page.waitForTimeout(500);

          // Look for selection handles
          const handles = await page.evaluate(() => {
            const hs = document.querySelectorAll('.tl-selection__handles .tl-handle');
            return Array.from(hs).map(h => {
              const r = h.getBoundingClientRect();
              return { cls: h.className, x: Math.round(r.x), y: Math.round(r.y) };
            });
          });
          console.log('Selection handles:', handles);
          await page.screenshot({ path: `${OUT}/qa-f2-v2-selected.png` });

          // Try using TLDraw editor to select and resize
          const resized = await page.evaluate((frameId) => {
            const ed = window.__tldraw_editor__;
            if (!ed) return { error: 'no editor' };

            // Try to find and select the shape
            const shapes = ed.getCurrentPageShapes();
            const pbf = shapes.find(s => s.type === 'playback-frame');
            if (!pbf) return { error: 'no playback-frame in doc editor' };

            ed.select(pbf.id);
            const before = ed.getShapePageBounds(pbf.id);

            // Resize via API
            ed.resizeShape(pbf.id,
              { x: (before.w + 150) / before.w, y: (before.h + 100) / before.h },
              { handle: 'bottom_right' }
            );
            const after = ed.getShapePageBounds(pbf.id);
            return {
              before: { w: Math.round(before.w), h: Math.round(before.h) },
              after: { w: Math.round(after.w), h: Math.round(after.h) }
            };
          }, frame.id);
          console.log('TLDraw resize result:', resized);
          await page.waitForTimeout(800);
          await page.screenshot({ path: `${OUT}/qa-f2-v2-resized.png` });
        }
      }
    }
    await page.close();
  }

  await browser.close();
  console.log('\n=== Done ===');
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
