import { chromium } from 'playwright';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5176/?token=${TOKEN}`;
const OUT = '/Users/skip/work/tlda/scratch';

async function waitForEditor(page, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(() => !!window.__tldraw_editor__)) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function run() {
  const browser = await chromium.launch({ headless: true });

  // ── F4: Fleet chat with visible textarea ──
  console.log('=== F4: Fleet chat shape screenshot ===');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`${BASE}&doc=survival-draft`);
    if (!await waitForEditor(page)) { console.log('No editor'); await page.close(); }
    else {
      // Create a fleet-chat shape in the CENTER of the viewport (no pan needed)
      const shapeId = await page.evaluate(() => {
        const ed = window.__tldraw_editor__;
        const cam = ed.getCamera();
        const z = cam.z || 1;
        // Place at viewport center
        const id = `shape:qa-fc-${Date.now()}`;
        // Center of viewport in page coords
        const cx = -cam.x / z + 700 / z;
        const cy = -cam.y / z + 400 / z;
        ed.createShape({ id, type: 'fleet-chat', x: cx - 175, y: cy - 250, props: { w: 350, h: 500, filter: [] } });
        return id;
      });
      console.log('Shape ID:', shapeId);
      await page.waitForTimeout(2500);

      // Find the shape element and take a focused screenshot
      const rect = await page.evaluate((id) => {
        const el = document.querySelector(`[data-shape-id="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }, shapeId);
      console.log('Fleet chat rect:', rect);

      await page.screenshot({ path: `${OUT}/qa-f4-fleet-chat.png` });

      if (rect && rect.w > 0) {
        await page.screenshot({
          path: `${OUT}/qa-f4-fleet-chat-clip.png`,
          clip: { x: Math.max(0, rect.x - 10), y: Math.max(0, rect.y - 10), width: rect.w + 20, height: rect.h + 20 }
        });
        console.log('Fleet chat clipped screenshot saved');
      }

      // Verify textarea visible
      const ta = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('textarea')).filter(t => {
          const r = t.getBoundingClientRect();
          return r.width > 50 && r.height > 10;
        }).map(t => ({ ph: t.placeholder, w: Math.round(t.getBoundingClientRect().width) }));
      });
      console.log('Visible textareas:', JSON.stringify(ta));
      await page.close();
    }
  }

  // ── F2: Clear before/after resize screenshots ──
  console.log('\n=== F2: PlaybackFrame resize proof ===');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`${BASE}&doc=survival-draft`);
    if (!await waitForEditor(page)) { console.log('No editor'); await page.close(); }
    else {
      // Place playback frame via keyboard shortcut
      await page.mouse.click(800, 450);
      await page.waitForTimeout(200);
      await page.keyboard.press('p');
      await page.waitForTimeout(300);
      await page.mouse.move(100, 50);
      await page.mouse.down();
      await page.mouse.move(450, 520, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(1500);

      // Wait for picker
      let ready = false;
      for (let i = 0; i < 20; i++) {
        const n = await page.evaluate(() => document.querySelectorAll('.pbf-picker-item').length);
        if (n > 0) { ready = true; break; }
        await page.waitForTimeout(400);
      }

      if (ready) {
        // Select first recording
        const item = await page.evaluate(() => {
          const el = document.querySelector('.pbf-picker-item');
          const r = el?.getBoundingClientRect();
          return r ? { x: Math.round(r.x + 40), y: Math.round(r.y + 8) } : null;
        });
        if (item) {
          await page.mouse.click(item.x, item.y);
          await page.waitForTimeout(4000);
        }
      }

      // Get frame position
      const frameBefore = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('[data-shape-type="playback-frame"]'));
        const el = els.find(e => e.getBoundingClientRect().width > 50) || els[0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const id = el.getAttribute('data-shape-id');
        return { x: r.x, y: r.y, w: r.width, h: r.height, id };
      });
      console.log('Frame before:', frameBefore);

      if (frameBefore) {
        // Clip screenshot of frame before resize
        await page.screenshot({
          path: `${OUT}/qa-f2-before-resize.png`,
          clip: { x: Math.max(0, frameBefore.x - 5), y: Math.max(0, frameBefore.y - 5),
                  width: Math.min(frameBefore.w + 10, 700), height: Math.min(frameBefore.h + 10, 870) }
        });
        console.log('Before screenshot saved:', Math.round(frameBefore.w), 'x', Math.round(frameBefore.h));

        // Resize via TLDraw API
        const resizeResult = await page.evaluate((id) => {
          const ed = window.__tldraw_editor__;
          const shape = ed.getCurrentPageShapes().find(s => s.id === id || s.type === 'playback-frame');
          if (!shape) return { error: 'shape not found' };
          const bounds = ed.getShapePageBounds(shape.id);
          if (!bounds) return { error: 'no bounds' };
          const newW = bounds.w + 200;
          const newH = bounds.h + 150;
          ed.resizeShape(shape.id, { x: newW / bounds.w, y: newH / bounds.h }, { handle: 'bottom_right' });
          const afterBounds = ed.getShapePageBounds(shape.id);
          return {
            before: { w: Math.round(bounds.w), h: Math.round(bounds.h) },
            after: { w: Math.round(afterBounds?.w || 0), h: Math.round(afterBounds?.h || 0) }
          };
        }, frameBefore.id);
        console.log('Resize result:', JSON.stringify(resizeResult));
        await page.waitForTimeout(600);

        // Get frame after
        const frameAfter = await page.evaluate((id) => {
          const el = document.querySelector(`[data-shape-id="${id}"]`) ||
                     document.querySelector('[data-shape-type="playback-frame"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }, frameBefore.id);
        console.log('Frame after:', frameAfter);

        if (frameAfter) {
          await page.screenshot({
            path: `${OUT}/qa-f2-after-resize.png`,
            clip: { x: Math.max(0, frameAfter.x - 5), y: Math.max(0, frameAfter.y - 5),
                    width: Math.min(frameAfter.w + 10, 1200), height: Math.min(frameAfter.h + 10, 870) }
          });
          console.log('After screenshot saved:', Math.round(frameAfter.w), 'x', Math.round(frameAfter.h));
        }
      }
      await page.close();
    }
  }

  await browser.close();
  console.log('\n=== Done ===');
}

run().catch(e => console.error(e.message));
