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
  if (!await waitForEditor(page)) { console.log('No editor'); await browser.close(); return; }

  // Wait for registerLayoutSideEffects to be called
  await page.waitForTimeout(1000);
  const registered = await page.evaluate(() => typeof window.__toggleLayoutMode__ === 'function');
  console.log('__toggleLayoutMode__ registered:', registered);

  // Get existing fleet shapes
  const fleetShapes = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    return ed.getCurrentPageShapes()
      .filter(s => ['fleet-chat', 'fleet-agents', 'fleet-search'].includes(s.type))
      .map(s => ({ type: s.type, id: s.id, x: s.x, y: s.y }));
  });
  console.log('Fleet shapes:', JSON.stringify(fleetShapes));

  // Get camera
  const cam = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    return ed.getCamera();
  });
  console.log('Camera:', JSON.stringify(cam));

  // Center on fleet shapes
  if (fleetShapes.length > 0) {
    await page.evaluate((shapes) => {
      const ed = window.__tldraw_editor__;
      const xs = shapes.map(s => s.x);
      const ys = shapes.map(s => s.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      ed.centerOnPoint({ x: cx, y: cy }, { animation: { duration: 0 } });
      ed.setCamera({ ...ed.getCamera(), z: 0.8 }, { animation: { duration: 0 } });
    }, fleetShapes);
    await page.waitForTimeout(500);
  }

  // Find the layout button
  const btn = await page.evaluate(() => {
    const el = document.querySelector('.fleet-layout-btn');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
  });
  console.log('Layout button element:', JSON.stringify(btn));

  await page.screenshot({ path: `${OUT}/hud-debug-before.png` });

  // Toggle via both methods and check
  console.log('\n--- Using __toggleLayoutMode__ ---');
  await page.evaluate(() => window.__toggleLayoutMode__?.());
  await page.waitForTimeout(1000);

  const state1 = await page.evaluate(() => ({
    isLayoutMode: window.__isLayoutMode__?.(),
    overlayExists: !!document.querySelector('.hud-layout-overlay'),
    overlayRect: (() => { const el = document.querySelector('.hud-layout-overlay'); return el ? el.getBoundingClientRect() : null; })(),
    btnHasActive: !!document.querySelector('.fleet-layout-btn.active'),
    allDivClasses: Array.from(document.querySelectorAll('.hud-layout-overlay, [class*="hud-layout"]')).map(el => ({ cls: el.className, rect: el.getBoundingClientRect() }))
  }));
  console.log('State after toggle:', JSON.stringify(state1, null, 2));
  await page.screenshot({ path: `${OUT}/hud-debug-toggled.png` });

  // Check computed bounds
  const bounds = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    const shapes = ed.getCurrentPageShapes().filter(s => ['fleet-chat', 'fleet-agents', 'fleet-search'].includes(s.type));
    if (shapes.length === 0) return { error: 'no fleet shapes' };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of shapes) {
      const b = ed.getShapePageBounds(s.id);
      if (b) { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); }
    }
    const cam = ed.getCamera();
    const boundsPage = { x: minX - 20, y: minY - 20, w: maxX - minX + 40, h: maxY - minY + 40 };
    const screenX = (boundsPage.x + cam.x) * cam.z;
    const screenY = (boundsPage.y + cam.y) * cam.z;
    return {
      boundsPage,
      cam,
      screen: { x: Math.round(screenX), y: Math.round(screenY), w: Math.round(boundsPage.w * cam.z), h: Math.round(boundsPage.h * cam.z) }
    };
  });
  console.log('Computed bounds:', JSON.stringify(bounds));

  await browser.close();
}

run().catch(e => console.error(e.message));
