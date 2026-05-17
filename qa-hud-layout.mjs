/**
 * HUD Layout Mode test — worktree hud-layout-v3
 * Server: vite dev server on port 5179 (proxies API to 5176)
 * Auth token from .dev-url
 */
import { chromium } from 'playwright';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5179/?token=${TOKEN}`;
const OUT = '/Users/skip/work/tlda/scratch';

async function waitForEditor(page, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(() => !!window.__tldraw_editor__)) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto(`${BASE}&doc=survival-draft`);

  console.log('Waiting for editor...');
  if (!await waitForEditor(page)) {
    console.log('Editor not ready. Taking debug screenshot.');
    await page.screenshot({ path: `${OUT}/hud-debug.png` });
    await browser.close();
    return;
  }
  console.log('Editor ready.');

  // ── Step 0: Baseline — create fleet shapes to work with ──────────────────
  const shapes = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    const existing = ed.getCurrentPageShapes().filter(s =>
      ['fleet-chat', 'fleet-agents', 'fleet-search'].includes(s.type)
    );
    return existing.map(s => ({ type: s.type, id: s.id, x: Math.round(s.x), y: Math.round(s.y) }));
  });
  console.log('Existing fleet shapes:', JSON.stringify(shapes));

  // Create fleet-agents shape if none exist (needed for ⊞ button)
  let agentsShapeId = shapes.find(s => s.type === 'fleet-agents')?.id;
  let chatShapeId = shapes.find(s => s.type === 'fleet-chat')?.id;

  if (!agentsShapeId) {
    agentsShapeId = await page.evaluate(() => {
      const ed = window.__tldraw_editor__;
      const vp = ed.getViewportPageBounds();
      const id = `shape:qa-agents-${Date.now()}`;
      ed.createShape({ id, type: 'fleet-agents', x: vp.x + 50, y: vp.y + 50, props: { w: 260, h: 380 } });
      return id;
    });
    console.log('Created fleet-agents:', agentsShapeId);
    await page.waitForTimeout(1500);
  }

  if (!chatShapeId) {
    chatShapeId = await page.evaluate(() => {
      const ed = window.__tldraw_editor__;
      const vp = ed.getViewportPageBounds();
      const id = `shape:qa-chat-${Date.now()}`;
      ed.createShape({ id, type: 'fleet-chat', x: vp.x + 340, y: vp.y + 50, props: { w: 320, h: 380, filter: [] } });
      return id;
    });
    console.log('Created fleet-chat:', chatShapeId);
    await page.waitForTimeout(1500);
  }

  // Center camera on the fleet shapes
  await page.evaluate((ids) => {
    const ed = window.__tldraw_editor__;
    const shapes = ed.getCurrentPageShapes().filter(s => ids.includes(s.id));
    if (shapes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of shapes) {
      const b = ed.getShapePageBounds(s.id);
      if (b) { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); }
    }
    ed.centerOnPoint({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, { animation: { duration: 0 } });
    ed.setCamera({ ...ed.getCamera(), z: 0.9 }, { animation: { duration: 0 } });
  }, [agentsShapeId, chatShapeId].filter(Boolean));
  await page.waitForTimeout(600);

  // ── Screenshot 1: Initial state with fleet shapes, before layout mode ─────
  await page.screenshot({ path: `${OUT}/hud-01-initial.png` });
  console.log('Screenshot 1: initial state');

  // ── Step 1: Find and click the ⊞ layout button ───────────────────────────
  // The button is in the fleet-agents shape, class "fleet-layout-btn"
  const layoutBtnInfo = await page.evaluate(() => {
    const btn = document.querySelector('.fleet-layout-btn');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), visible: r.width > 0 };
  });
  console.log('Layout button:', layoutBtnInfo);

  if (layoutBtnInfo && layoutBtnInfo.visible) {
    // Click the ⊞ button
    await page.mouse.click(layoutBtnInfo.x, layoutBtnInfo.y);
    await page.waitForTimeout(600);
  } else {
    // Use programmatic toggle as fallback
    console.log('Button not visible, using programmatic toggle');
    await page.evaluate(() => window.__toggleLayoutMode__?.());
    await page.waitForTimeout(600);
  }

  // Verify layout mode is on
  const layoutOn = await page.evaluate(() => window.__isLayoutMode__?.() || false);
  console.log('Layout mode active:', layoutOn);

  // ── Screenshot 2: Layout mode ON — overlay visible ──────────────────────
  await page.screenshot({ path: `${OUT}/hud-02-layout-on.png` });
  console.log('Screenshot 2: layout mode on');

  // Check overlay DOM
  const overlayInfo = await page.evaluate(() => {
    const overlay = document.querySelector('.hud-layout-overlay');
    if (!overlay) return null;
    const r = overlay.getBoundingClientRect();
    const handles = overlay.querySelectorAll('[data-handle]');
    const label = overlay.querySelector('.hud-container-label');
    const exitBtn = overlay.querySelector('.hud-container-exit-btn');
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      handleCount: handles.length,
      label: label?.textContent,
      exitBtnText: exitBtn?.textContent,
    };
  });
  console.log('Overlay:', JSON.stringify(overlayInfo));

  // Clip the overlay area for a tight screenshot
  if (overlayInfo && overlayInfo.w > 0) {
    await page.screenshot({
      path: `${OUT}/hud-02b-overlay-clip.png`,
      clip: {
        x: Math.max(0, overlayInfo.x - 30),
        y: Math.max(0, overlayInfo.y - 30),
        width: Math.min(overlayInfo.w + 60, 1600),
        height: Math.min(overlayInfo.h + 60, 860),
      }
    });
    console.log('Screenshot 2b: overlay clipped');
  }

  // ── Step 2: Resize the overlay by dragging bottom-right handle ───────────
  // Get pre-resize shape bounds
  const preBounds = await page.evaluate((ids) => {
    const ed = window.__tldraw_editor__;
    return ids.filter(Boolean).map(id => {
      const b = ed.getShapePageBounds(id);
      return b ? { id, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) } : null;
    }).filter(Boolean);
  }, [agentsShapeId, chatShapeId]);
  console.log('Pre-resize bounds:', JSON.stringify(preBounds));

  // Find the bottom-right handle
  const brHandle = await page.evaluate(() => {
    const h = document.querySelector('[data-handle="bottom-right"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  });
  console.log('Bottom-right handle:', brHandle);

  if (brHandle) {
    // Drag the handle by +120, +80 pixels
    await page.mouse.move(brHandle.x, brHandle.y);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.move(brHandle.x + 120, brHandle.y + 80, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    // ── Screenshot 3: After resize — shapes scaled ─────────────────────────
    await page.screenshot({ path: `${OUT}/hud-03-resized.png` });
    console.log('Screenshot 3: after resize');

    // Clip to overlay area
    const overlayAfter = await page.evaluate(() => {
      const overlay = document.querySelector('.hud-layout-overlay');
      if (!overlay) return null;
      const r = overlay.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    if (overlayAfter) {
      await page.screenshot({
        path: `${OUT}/hud-03b-resized-clip.png`,
        clip: {
          x: Math.max(0, overlayAfter.x - 30),
          y: Math.max(0, overlayAfter.y - 30),
          width: Math.min(overlayAfter.w + 60, 1600),
          height: Math.min(overlayAfter.h + 60, 860),
        }
      });
    }

    // Check post-resize shape bounds
    const postBounds = await page.evaluate((ids) => {
      const ed = window.__tldraw_editor__;
      return ids.filter(Boolean).map(id => {
        const b = ed.getShapePageBounds(id);
        return b ? { id, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) } : null;
      }).filter(Boolean);
    }, [agentsShapeId, chatShapeId]);
    console.log('Post-resize bounds:', JSON.stringify(postBounds));

    // Verify proportional scaling
    for (let i = 0; i < preBounds.length; i++) {
      const pre = preBounds[i];
      const post = postBounds.find(b => b?.id === pre.id);
      if (post) {
        const wChange = post.w - pre.w;
        const hChange = post.h - pre.h;
        console.log(`  ${pre.id.slice(-8)}: ${pre.w}×${pre.h} → ${post.w}×${post.h} (Δw=${wChange}, Δh=${hChange})`);
      }
    }
  }

  // ── Step 3: Exit layout mode via Done button ─────────────────────────────
  const exitBtn = await page.evaluate(() => {
    const btn = document.querySelector('.hud-container-exit-btn');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  });
  console.log('Exit button:', exitBtn);

  if (exitBtn) {
    await page.mouse.click(exitBtn.x, exitBtn.y);
    await page.waitForTimeout(600);
  } else {
    await page.evaluate(() => window.__toggleLayoutMode__?.());
    await page.waitForTimeout(600);
  }

  const layoutOff = await page.evaluate(() => !(window.__isLayoutMode__?.() || false));
  console.log('Layout mode exited:', layoutOff);

  // Check overlay is gone
  const overlayGone = await page.evaluate(() => !document.querySelector('.hud-layout-overlay'));
  console.log('Overlay removed:', overlayGone);

  // ── Screenshot 4: After exit — overlay gone, shapes remain ───────────────
  await page.screenshot({ path: `${OUT}/hud-04-exited.png` });
  console.log('Screenshot 4: after exit');

  // Final shape bounds — should still be the resized positions
  const finalBounds = await page.evaluate((ids) => {
    const ed = window.__tldraw_editor__;
    return ids.filter(Boolean).map(id => {
      const b = ed.getShapePageBounds(id);
      return b ? { id: id.slice(-8), w: Math.round(b.w), h: Math.round(b.h) } : null;
    }).filter(Boolean);
  }, [agentsShapeId, chatShapeId]);
  console.log('Final shape bounds (should be resized):', JSON.stringify(finalBounds));

  // ── Screenshot 5: Check button state (⊞ inactive after exit) ─────────────
  const btnActive = await page.evaluate(() => !!document.querySelector('.fleet-layout-btn.active'));
  console.log('Layout button active class after exit:', btnActive, '(should be false)');

  await browser.close();
  console.log('\n=== Done ===');
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
