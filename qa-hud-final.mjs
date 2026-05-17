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

  if (!await waitForEditor(page)) { console.log('Editor not ready'); await browser.close(); return; }
  await page.waitForTimeout(1000); // let registerLayoutSideEffects fire

  // Get fleet shapes and center camera on them
  const setupResult = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    const fleetShapes = ed.getCurrentPageShapes()
      .filter(s => ['fleet-chat', 'fleet-agents', 'fleet-search'].includes(s.type));

    if (fleetShapes.length === 0) return { error: 'no fleet shapes' };

    // Compute center
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of fleetShapes) {
      const b = ed.getShapePageBounds(s.id);
      if (b) { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); }
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    ed.centerOnPoint({ x: cx, y: cy }, { animation: { duration: 0 } });
    ed.setCamera({ ...ed.getCamera(), z: 0.8 }, { animation: { duration: 0 } });

    return {
      shapeCount: fleetShapes.length,
      types: fleetShapes.map(s => s.type),
      ids: fleetShapes.map(s => s.id),
    };
  });
  console.log('Setup:', JSON.stringify(setupResult));
  await page.waitForTimeout(500);

  // ── Screenshot 1: Initial state ───────────────────────────────────────────
  await page.screenshot({ path: `${OUT}/hud-01-initial.png` });
  console.log('Screenshot 1: initial state (fleet shapes visible, no overlay)');

  // Capture pre-layout shape bounds
  const preBounds = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    return ed.getCurrentPageShapes()
      .filter(s => ['fleet-chat', 'fleet-agents', 'fleet-search'].includes(s.type))
      .map(s => {
        const b = ed.getShapePageBounds(s.id);
        return { id: s.id.slice(-8), type: s.type, w: Math.round(b?.w || 0), h: Math.round(b?.h || 0) };
      });
  });
  console.log('Pre-layout bounds:', JSON.stringify(preBounds));

  // ── Step 1: Enter layout mode ─────────────────────────────────────────────
  // Use the ⊞ button on agents panel (via pointerup dispatch to bypass TLDraw capture)
  const btnClicked = await page.evaluate(() => {
    const btn = document.querySelector('.fleet-layout-btn');
    if (!btn) return false;
    // Use pointer events directly on the element (capture-phase bypass)
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    return true;
  });
  console.log('Button click dispatched:', btnClicked);
  await page.waitForTimeout(800);

  // Verify layout mode is on
  const layoutOn = await page.evaluate(() => window.__isLayoutMode__());
  console.log('Layout mode on:', layoutOn);

  // If button didn't work, use programmatic toggle
  if (!layoutOn) {
    console.log('Button dispatch failed, using __toggleLayoutMode__');
    await page.evaluate(() => window.__toggleLayoutMode__());
    await page.waitForTimeout(600);
  }

  // ── Screenshot 2: Layout mode ON ─────────────────────────────────────────
  const overlayRect = await page.evaluate(() => {
    const el = document.querySelector('.hud-layout-overlay');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('Overlay rect:', JSON.stringify(overlayRect));

  await page.screenshot({ path: `${OUT}/hud-02-layout-on.png` });
  if (overlayRect) {
    const pad = 40;
    await page.screenshot({
      path: `${OUT}/hud-02b-overlay-clip.png`,
      clip: { x: Math.max(0, overlayRect.x - pad), y: Math.max(0, overlayRect.y - pad),
               width: Math.min(overlayRect.w + pad*2, 1800), height: Math.min(overlayRect.h + pad*2, 900) }
    });
  }
  console.log('Screenshot 2: layout mode on with overlay');

  // Check overlay has handles, label, Done button
  const overlayDetails = await page.evaluate(() => {
    const handles = [...document.querySelectorAll('[data-handle]')].map(h => h.dataset.handle);
    const label = document.querySelector('.hud-container-label')?.textContent;
    const exitBtnText = document.querySelector('.hud-container-exit-btn')?.textContent;
    return { handles, label, exitBtnText };
  });
  console.log('Overlay details:', JSON.stringify(overlayDetails));

  // ── Step 2: Drag bottom-right resize handle ───────────────────────────────
  const brHandle = await page.evaluate(() => {
    const h = document.querySelector('[data-handle="bottom-right"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  });
  console.log('Bottom-right handle at:', JSON.stringify(brHandle));

  if (brHandle) {
    await page.mouse.move(brHandle.x, brHandle.y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.mouse.move(brHandle.x + 150, brHandle.y + 100, { steps: 20 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(800);

    // ── Screenshot 3: After resize ──────────────────────────────────────────
    await page.screenshot({ path: `${OUT}/hud-03-resized.png` });
    const overlayAfter = await page.evaluate(() => {
      const el = document.querySelector('.hud-layout-overlay');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    if (overlayAfter) {
      const pad = 40;
      await page.screenshot({
        path: `${OUT}/hud-03b-resized-clip.png`,
        clip: { x: Math.max(0, overlayAfter.x - pad), y: Math.max(0, overlayAfter.y - pad),
                 width: Math.min(overlayAfter.w + pad*2, 1800), height: Math.min(overlayAfter.h + pad*2, 900) }
      });
    }
    console.log('Screenshot 3: after resize. Overlay now:', JSON.stringify(overlayAfter));

    // Check shape bounds changed proportionally
    const postBounds = await page.evaluate(() => {
      const ed = window.__tldraw_editor__;
      return ed.getCurrentPageShapes()
        .filter(s => ['fleet-chat', 'fleet-agents', 'fleet-search'].includes(s.type))
        .map(s => {
          const b = ed.getShapePageBounds(s.id);
          return { id: s.id.slice(-8), type: s.type, w: Math.round(b?.w || 0), h: Math.round(b?.h || 0) };
        });
    });
    console.log('Post-resize bounds:', JSON.stringify(postBounds));

    // Compare
    console.log('Resize delta:');
    for (const post of postBounds) {
      const pre = preBounds.find(p => p.id === post.id);
      if (pre) {
        console.log(`  ${post.type}(${post.id}): ${pre.w}×${pre.h} → ${post.w}×${post.h}`);
      }
    }
  }

  // ── Step 3: Exit via Done button ─────────────────────────────────────────
  const exitBtn = await page.evaluate(() => {
    const btn = document.querySelector('.hud-container-exit-btn');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: btn.textContent };
  });
  console.log('Exit button:', JSON.stringify(exitBtn));

  if (exitBtn) {
    // Use pointerdown + pointerup (matching what the HudLayoutOverlay listens for)
    await page.mouse.move(exitBtn.x, exitBtn.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(600);
  } else {
    await page.evaluate(() => window.__toggleLayoutMode__());
    await page.waitForTimeout(500);
  }

  const layoutOff = await page.evaluate(() => !window.__isLayoutMode__());
  const overlayGone = await page.evaluate(() => !document.querySelector('.hud-layout-overlay'));
  const btnInactive = await page.evaluate(() => !document.querySelector('.fleet-layout-btn.active'));
  console.log('Layout off:', layoutOff, '| Overlay gone:', overlayGone, '| Button inactive:', btnInactive);

  // ── Screenshot 4: After exit ──────────────────────────────────────────────
  await page.screenshot({ path: `${OUT}/hud-04-exited.png` });
  console.log('Screenshot 4: layout mode exited, shapes remain at new positions');

  // Final bounds — shapes should stay at resized positions
  const finalBounds = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    return ed.getCurrentPageShapes()
      .filter(s => ['fleet-chat', 'fleet-agents', 'fleet-search'].includes(s.type))
      .map(s => {
        const b = ed.getShapePageBounds(s.id);
        return { type: s.type, w: Math.round(b?.w || 0), h: Math.round(b?.h || 0) };
      });
  });
  console.log('Final bounds (shapes stay at resized positions):', JSON.stringify(finalBounds));

  await browser.close();
  console.log('\n=== Done ===');
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
