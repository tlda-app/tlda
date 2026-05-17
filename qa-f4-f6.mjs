import { chromium } from 'playwright';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5176/?token=${TOKEN}`;
const OUT = '/Users/skip/work/tlda/scratch';

async function waitForEditor(page, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ready = await page.evaluate(() => !!window.__tldraw_editor__);
    if (ready) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function run() {
  const browser = await chromium.launch({ headless: true });

  // ── F6: Math note with \E[X] macro ──────────────────────────────────────
  console.log('\n=== F6: Math note with \\E[X] macro ===');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 2000, height: 900 });
    await page.goto(`${BASE}&doc=survival-draft`);

    // Wait for TLDraw editor to be ready (up to 15s)
    const editorReady = await waitForEditor(page);
    console.log('Editor ready:', editorReady);

    if (editorReady) {
      // Check current shapes to find good coordinates
      const info = await page.evaluate(() => {
        const ed = window.__tldraw_editor__;
        const shapes = ed.getCurrentPageShapes();
        const cam = ed.getCamera();
        return { shapeCount: shapes.length, cam, viewport: ed.getViewportPageBounds() };
      });
      console.log('Canvas info:', JSON.stringify(info));

      // Create a math note via TLDraw API at a visible position
      const result = await page.evaluate(() => {
        const ed = window.__tldraw_editor__;
        const vp = ed.getViewportPageBounds();
        // Place in center of viewport
        const cx = vp.x + vp.w / 2;
        const cy = vp.y + vp.h / 4;

        const id = `shape:qa-f6-${Date.now()}`;
        ed.createShape({
          id,
          type: 'math-note',
          x: cx - 110,
          y: cy - 40,
          props: { text: '$\\E[X]$', w: 220, h: 80 }
        });
        return { id, x: Math.round(cx), y: Math.round(cy) };
      });
      console.log('Created:', result);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${OUT}/qa-f6-v2-full.png` });

      // Find the math note's DOM position
      const noteRect = await page.evaluate((shapeId) => {
        const el = document.querySelector(`[data-shape-id="${shapeId}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }, result.id);
      console.log('Note DOM rect:', noteRect);

      if (noteRect && noteRect.w > 0) {
        await page.screenshot({
          path: `${OUT}/qa-f6-v2-clip.png`,
          clip: {
            x: Math.max(0, noteRect.x - 20),
            y: Math.max(0, noteRect.y - 20),
            width: Math.min(noteRect.w + 40, 500),
            height: Math.min(noteRect.h + 40, 200)
          }
        });
        console.log('Clipped screenshot saved');
      }

      // Check for KaTeX content
      const katex = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.katex')).map(k => ({
          text: k.textContent?.trim().slice(0, 40),
          classes: k.className
        }));
      });
      console.log('KaTeX elements:', katex.length, JSON.stringify(katex.slice(0, 5)));

      // Check note innerHTML
      const noteContent = await page.evaluate((shapeId) => {
        const el = document.querySelector(`[data-shape-id="${shapeId}"]`);
        return el ? el.innerHTML.slice(0, 400) : 'not found';
      }, result.id);
      console.log('Note HTML:', noteContent.slice(0, 300));
    }
    await page.close();
  }

  // ── F4: File drag ─────────────────────────────────────────────────────
  console.log('\n=== F4: File drag onto fleet chat ===');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 2000, height: 900 });
    await page.goto(`${BASE}&doc=survival-draft`);

    const editorReady = await waitForEditor(page);
    console.log('Editor ready:', editorReady);

    if (editorReady) {
      // Find fleet-chat shapes in editor store
      const shapes = await page.evaluate(() => {
        const ed = window.__tldraw_editor__;
        const all = ed.getCurrentPageShapes();
        const chats = all.filter(s => s.type === 'fleet-chat');
        return chats.map(s => ({
          id: s.id,
          x: Math.round(s.x), y: Math.round(s.y),
          agent: s.props?.agent || 'unknown',
          w: Math.round(s.props?.w || 0), h: Math.round(s.props?.h || 0)
        }));
      });
      console.log('Fleet-chat shapes:', JSON.stringify(shapes));

      if (shapes.length > 0) {
        const fc = shapes[0];

        // Zoom to the fleet chat shape
        await page.evaluate((shape) => {
          const ed = window.__tldraw_editor__;
          const vp = ed.getViewportPageBounds();
          // Center camera on the shape
          ed.centerOnPoint({ x: shape.x + (shape.w || 300)/2, y: shape.y + (shape.h || 400)/2 },
            { animation: { duration: 0 } });
          ed.setCamera({ ...ed.getCamera(), z: 0.8 }, { animation: { duration: 0 } });
        }, fc);
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${OUT}/qa-f4-v2-zoomed.png` });

        // Now find the textarea
        const taInfo = await page.evaluate(() => {
          const tas = Array.from(document.querySelectorAll('textarea'));
          return tas.map(t => {
            const r = t.getBoundingClientRect();
            return { ph: t.placeholder, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          });
        });
        console.log('Textareas after zoom:', JSON.stringify(taInfo));

        // Drop file on the first visible textarea
        const dropResult = await page.evaluate(async () => {
          const ta = Array.from(document.querySelectorAll('textarea')).find(t => {
            const r = t.getBoundingClientRect();
            return r.width > 50 && r.height > 10;
          });
          if (!ta) return { error: 'no visible textarea' };

          const file = new File(['# Test file content'], 'qa-drop-test.md', { type: 'text/plain' });
          const dt = new DataTransfer();
          dt.items.add(file);

          ta.focus();
          ta.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
          await new Promise(r => setTimeout(r, 200));
          ta.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
          await new Promise(r => setTimeout(r, 200));
          ta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
          await new Promise(r => setTimeout(r, 5000));

          const r = ta.getBoundingClientRect();
          return { placeholder: ta.placeholder, value: ta.value.slice(0, 300), pos: { x: r.x, y: r.y, w: r.width } };
        });
        console.log('Drop result:', JSON.stringify(dropResult));
        await page.screenshot({ path: `${OUT}/qa-f4-v2-dropped.png` });
      } else {
        console.log('No fleet-chat shapes found — they might not exist in this session');
        // Take a screenshot and verify via API
        await page.screenshot({ path: `${OUT}/qa-f4-v2-no-shapes.png` });

        // Create a fleet-chat shape for testing
        const created = await page.evaluate(() => {
          const ed = window.__tldraw_editor__;
          const vp = ed.getViewportPageBounds();
          const id = `shape:qa-fleet-chat-${Date.now()}`;
          try {
            ed.createShape({
              id,
              type: 'fleet-chat',
              x: vp.x + 100, y: vp.y + 100,
              props: { agent: 'historian', w: 300, h: 400 }
            });
            return { id, success: true };
          } catch(e) {
            return { error: e.message };
          }
        });
        console.log('Created fleet-chat:', created);
        await page.waitForTimeout(2000);
        await page.screenshot({ path: `${OUT}/qa-f4-v2-created-chat.png` });

        // Now try dropping on textarea
        const dropResult = await page.evaluate(async () => {
          const ta = Array.from(document.querySelectorAll('textarea')).find(t => {
            const r = t.getBoundingClientRect();
            return r.width > 50 && r.height > 10;
          });
          if (!ta) return { error: 'no visible textarea after creation' };

          const file = new File(['# Test file'], 'qa-drop.md', { type: 'text/plain' });
          const dt = new DataTransfer();
          dt.items.add(file);
          ta.focus();
          ta.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
          await new Promise(r => setTimeout(r, 200));
          ta.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
          await new Promise(r => setTimeout(r, 200));
          ta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
          await new Promise(r => setTimeout(r, 5000));
          const r = ta.getBoundingClientRect();
          return { placeholder: ta.placeholder, value: ta.value.slice(0, 300), pos: { x: r.x, y: r.y } };
        });
        console.log('Drop on created chat:', JSON.stringify(dropResult));
        await page.screenshot({ path: `${OUT}/qa-f4-v2-drop-on-created.png` });
      }
    }
    await page.close();
  }

  await browser.close();
  console.log('\n=== Done ===');
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
