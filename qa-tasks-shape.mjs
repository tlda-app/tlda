import { chromium } from 'playwright';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5179/?token=${TOKEN}`;
const OUT = '/Users/skip/work/tlda/scratch';

async function waitForEditor(page, timeout = 15000) {
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
  await page.setViewportSize({ width: 1600, height: 900 });

  await page.goto(`${BASE}&doc=survival-draft`);
  if (!await waitForEditor(page)) { console.log('Editor not ready'); await browser.close(); return; }
  await page.waitForTimeout(2000);

  // Create the tasks shape via JS API
  const shapeId = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    const vp = ed.getViewportPageBounds();
    const id = 'shape:qa-tasks-' + Date.now();
    ed.createShape({
      id,
      type: 'fleet-tasks',
      x: vp.x + 30,
      y: vp.y + 30,
      props: { w: 340, h: 420 },
    });
    return id;
  });
  console.log('Created tasks shape:', shapeId);
  await page.waitForTimeout(1500);

  // Screenshot 1: tasks shape visible with live data
  const shapeRect = await page.evaluate((id) => {
    const el = document.querySelector(`[data-shape-id="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }, shapeId);
  console.log('Shape rect:', JSON.stringify(shapeRect));

  await page.screenshot({ path: `${OUT}/tasks-shape-01-full.png` });

  if (shapeRect) {
    await page.screenshot({
      path: `${OUT}/tasks-shape-02-clip.png`,
      clip: {
        x: Math.max(0, shapeRect.x - 5),
        y: Math.max(0, shapeRect.y - 5),
        width: Math.min(shapeRect.w + 10, 1600),
        height: Math.min(shapeRect.h + 10, 900),
      }
    });
    console.log('Screenshot 2: tasks shape clipped');
  }

  // Check what's rendered in the shape
  const shapeContent = await page.evaluate((id) => {
    const el = document.querySelector(`[data-shape-id="${id}"]`);
    if (!el) return null;
    const tabs = Array.from(el.querySelectorAll('.fleet-tasks-tab')).map(t => ({
      text: t.textContent?.trim(),
      active: t.classList.contains('active'),
    }));
    const rows = Array.from(el.querySelectorAll('.fleet-tasks-row')).map(r => ({
      agent: r.querySelector('.fleet-tasks-col-agent')?.textContent?.trim(),
      desc: r.querySelector('.fleet-tasks-col-desc')?.textContent?.trim(),
      status: r.querySelector('.fleet-tasks-col-status')?.textContent?.trim(),
      age: r.querySelector('.fleet-tasks-col-age')?.textContent?.trim(),
    }));
    const empty = el.querySelector('.fleet-tasks-empty')?.textContent?.trim();
    return { tabs, rows, empty };
  }, shapeId);
  console.log('Shape content:', JSON.stringify(shapeContent, null, 2));

  // Click "all" tab
  const allTabClicked = await page.evaluate((id) => {
    const el = document.querySelector(`[data-shape-id="${id}"]`);
    if (!el) return false;
    const tabs = el.querySelectorAll('.fleet-tasks-tab');
    for (const t of tabs) {
      if (t.textContent?.includes('all')) {
        t.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        return true;
      }
    }
    return false;
  }, shapeId);
  console.log('Clicked all tab:', allTabClicked);
  await page.waitForTimeout(500);

  await page.screenshot({
    path: `${OUT}/tasks-shape-03-all-tab.png`,
    clip: shapeRect ? {
      x: Math.max(0, shapeRect.x - 5),
      y: Math.max(0, shapeRect.y - 5),
      width: Math.min(shapeRect.w + 10, 1600),
      height: Math.min(shapeRect.h + 10, 900),
    } : undefined
  });
  console.log('Screenshot 3: all tab');

  // Check rows in all mode
  const allRows = await page.evaluate((id) => {
    const el = document.querySelector(`[data-shape-id="${id}"]`);
    if (!el) return [];
    return Array.from(el.querySelectorAll('.fleet-tasks-row')).map(r => ({
      agent: r.querySelector('.fleet-tasks-col-agent')?.textContent?.trim(),
      desc: r.querySelector('.fleet-tasks-col-desc')?.textContent?.trim()?.slice(0, 50),
      status: r.querySelector('.fleet-tasks-col-status')?.textContent?.trim(),
    }));
  }, shapeId);
  console.log('All rows:', JSON.stringify(allRows));

  // Clean up
  await page.evaluate((id) => {
    window.__tldraw_editor__.deleteShapes([id]);
  }, shapeId);

  await browser.close();
  console.log('Done');
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
