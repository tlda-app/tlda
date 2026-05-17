const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  await page.goto('http://localhost:5176/?doc=fleet-review&token=c5e4726ab77972fc7312f3a703f9cf1c');
  await page.waitForTimeout(4000);
  await page.evaluate(() => localStorage.setItem('fleet-hud-expanded', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Add a pointerdown listener to track what's happening
  await page.evaluate(() => {
    window.__clickLog = [];
    document.addEventListener('pointerdown', (e) => {
      const target = e.target;
      const inHud = !!target.closest('.fleet-hud-wrap');
      const inAgents = !!target.closest('.fleet-agents-shape');
      const row = target.closest('.fleet-agents-row-main');
      window.__clickLog.push({
        x: e.clientX, y: e.clientY,
        target: target.tagName + '.' + (target.className || '').substring(0, 40),
        inHud, inAgents,
        rowText: row?.textContent?.substring(0, 20) || null,
        phase: 'capture-doc',
      });
    }, true);
  });

  // Get the overlay agents rect
  const agentsRect = await page.evaluate(() => {
    const allAgents = document.querySelectorAll('.fleet-agents-shape');
    for (const a of allAgents) {
      if (a.closest('.fleet-hud-wrap')) {
        const r = a.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
    }
    return null;
  });
  console.log('Agents rect:', JSON.stringify(agentsRect));

  if (!agentsRect) { console.log('No agents shape'); await browser.close(); return; }

  // Check what tldraw thinks is at each row position
  // We need the overlay editor to convert screen→page coords
  const diagnostics = await page.evaluate(() => {
    const hudWrap = document.querySelector('.fleet-hud-wrap');
    const tlContainer = hudWrap?.querySelector('.tl-container');

    // Check all zoom/transform values on the tldraw DOM chain
    const chain = [];
    let el = hudWrap?.querySelector('.fleet-agents-shape');
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      const entry = {
        tag: el.tagName,
        class: (el.className || '').substring(0, 50),
      };
      if (s.zoom !== 'normal' && s.zoom !== '1') entry.zoom = s.zoom;
      if (s.transform !== 'none') entry.transform = s.transform;
      chain.push(entry);
      el = el.parentElement;
    }

    return { domChain: chain };
  });
  console.log('DOM chain:', JSON.stringify(diagnostics.domChain, null, 2));

  // Click at each row and check the log
  const rows = await page.evaluate(() => {
    const hudWrap = document.querySelector('.fleet-hud-wrap');
    const agents = hudWrap?.querySelector('.fleet-agents-shape');
    const rows = agents?.querySelectorAll('.fleet-agents-row-main');
    if (!rows) return [];
    return Array.from(rows).slice(0, 8).map(r => {
      const rect = r.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: r.textContent?.substring(0, 15) };
    });
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Clear click log
    await page.evaluate(() => { window.__clickLog = []; });

    // Click
    await page.mouse.click(row.x, row.y);
    await page.waitForTimeout(300);

    // Check result
    const result = await page.evaluate((idx) => {
      const hudWrap = document.querySelector('.fleet-hud-wrap');
      const agents = hudWrap?.querySelector('.fleet-agents-shape');
      const expanded = agents?.querySelectorAll('.fleet-agents-row.expanded').length || 0;
      return {
        clickLog: window.__clickLog,
        expanded,
      };
    }, i);

    const worked = result.expanded > 0 ? '✓' : '✗';
    console.log(`Row ${i} (${row.text}) at (${Math.round(row.x)}, ${Math.round(row.y)}): ${worked}  logs=${result.clickLog.length}`);
    if (result.clickLog.length > 0) {
      console.log('  ', JSON.stringify(result.clickLog[0]));
    }

    // Collapse any expanded
    await page.evaluate(() => {
      // Click elsewhere to collapse
    });
  }

  await page.screenshot({ path: '/Users/skip/work/tlda/debug-hittest2.png', scale: 'css' });
  console.log('\nScreenshot saved');

  await page.waitForTimeout(15000);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
