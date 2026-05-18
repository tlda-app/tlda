const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2  // Retina
  });
  const page = await context.newPage();
  await page.goto('http://localhost:5176/?doc=fleet-review&token=c5e4726ab77972fc7312f3a703f9cf1c');
  await page.waitForTimeout(4000);

  // Expand the fleet HUD — click the pill or set localStorage
  await page.evaluate(() => localStorage.setItem('fleet-hud-expanded', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Get overlay agents shape and test click behavior row by row
  const info = await page.evaluate(() => {
    const hudWrap = document.querySelector('.fleet-hud-wrap');
    if (!hudWrap) return { error: 'no hud wrap' };

    // Find overlay agents
    const allAgents = document.querySelectorAll('.fleet-agents-shape');
    let overlayAgents = null;
    for (const a of allAgents) {
      if (a.closest('.fleet-hud-wrap')) { overlayAgents = a; break; }
    }
    if (!overlayAgents) return { error: 'no overlay agents' };

    const rect = overlayAgents.getBoundingClientRect();

    // Check DPR, zoom, transforms
    const dpr = window.devicePixelRatio;
    const canvas = hudWrap.querySelector('.tl-canvas');
    const canvasZoom = canvas ? getComputedStyle(canvas).zoom : 'n/a';
    const shapesLayer = hudWrap.querySelector('.tl-html-layer.tl-shapes');
    const shapesTransform = shapesLayer ? getComputedStyle(shapesLayer).transform : 'n/a';

    // Check the clip-panel-fullvp zoom
    const clipPanel = hudWrap.querySelector('.clip-panel-fullvp');
    const clipZoom = clipPanel ? getComputedStyle(clipPanel).zoom : 'n/a';
    const clipTransform = clipPanel ? getComputedStyle(clipPanel).transform : 'n/a';

    // Check the tl-container zoom
    const tlContainer = hudWrap.querySelector('.tl-container');
    const containerZoom = tlContainer ? getComputedStyle(tlContainer).zoom : 'n/a';

    // Hit test at rows
    const rows = overlayAgents.querySelectorAll('.fleet-agents-row-main');
    const rowInfo = [];
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const r = rows[i].getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const el = document.elementFromPoint(cx, cy);
      rowInfo.push({
        row: i,
        text: rows[i].textContent?.substring(0, 20),
        y: Math.round(r.y),
        hitElement: el ? el.tagName + '.' + (el.className || '').substring(0, 50) : 'null',
        hitInside: el ? overlayAgents.contains(el) : false,
        hitPE: el ? getComputedStyle(el).pointerEvents : 'n/a',
      });
    }

    return {
      dpr,
      canvasZoom,
      containerZoom,
      clipZoom,
      clipTransform,
      shapesTransform,
      agentsRect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      rowInfo,
    };
  });

  console.log(JSON.stringify(info, null, 2));

  // Now test actual clicking — click each row and check if it expanded
  for (let i = 0; i < 8; i++) {
    const rowRect = await page.evaluate((idx) => {
      const hudWrap = document.querySelector('.fleet-hud-wrap');
      const agents = hudWrap?.querySelector('.fleet-agents-shape');
      const rows = agents?.querySelectorAll('.fleet-agents-row-main');
      if (!rows || !rows[idx]) return null;
      const r = rows[idx].getBoundingClientRect();
      // collapse any previously expanded
      const expanded = agents.querySelectorAll('.fleet-agents-row.expanded');
      for (const e of expanded) e.classList.remove('expanded');
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: rows[idx].textContent?.substring(0, 20) };
    }, i);

    if (!rowRect || rowRect.x > 1440) { console.log(`Row ${i}: off-screen`); continue; }

    await page.mouse.click(rowRect.x, rowRect.y);
    await page.waitForTimeout(200);

    const expanded = await page.evaluate(() => {
      const hudWrap = document.querySelector('.fleet-hud-wrap');
      const agents = hudWrap?.querySelector('.fleet-agents-shape');
      return agents?.querySelectorAll('.fleet-agents-row.expanded').length || 0;
    });

    console.log(`Row ${i} (${rowRect.text?.trim()}): click at (${Math.round(rowRect.x)}, ${Math.round(rowRect.y)}) → expanded=${expanded}`);
  }

  await page.screenshot({ path: '/Users/skip/work/tlda/debug-hittest.png', scale: 'css' });
  console.log('Screenshot saved to debug-hittest.png');

  // Keep open briefly
  await page.waitForTimeout(30000);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
