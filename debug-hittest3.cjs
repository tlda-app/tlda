const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5176/?doc=fleet-review&token=c5e4726ab77972fc7312f3a703f9cf1c');
  await page.waitForTimeout(4000);
  await page.evaluate(() => localStorage.setItem('fleet-hud-expanded', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Instrument pointer events to see who captures them
  await page.evaluate(() => {
    window.__pointerLog = [];

    // Listen at document capture phase
    document.addEventListener('pointerdown', (e) => {
      window.__pointerLog.push({
        phase: 'doc-capture',
        target: e.target?.tagName + '.' + (e.target?.className || '').substring(0, 40),
        x: e.clientX, y: e.clientY,
        pointerId: e.pointerId,
      });
    }, true);

    // Listen at document bubble phase
    document.addEventListener('pointerdown', (e) => {
      window.__pointerLog.push({
        phase: 'doc-bubble',
        target: e.target?.tagName + '.' + (e.target?.className || '').substring(0, 40),
      });
    }, false);

    // Monitor setPointerCapture
    const origCapture = Element.prototype.setPointerCapture;
    Element.prototype.setPointerCapture = function(pid) {
      window.__pointerLog.push({
        phase: 'setPointerCapture',
        element: this.tagName + '.' + (this.className || '').substring(0, 40),
        pointerId: pid,
      });
      return origCapture.call(this, pid);
    };

    // Listen on pointerup
    document.addEventListener('pointerup', (e) => {
      window.__pointerLog.push({
        phase: 'doc-pointerup',
        target: e.target?.tagName + '.' + (e.target?.className || '').substring(0, 40),
      });
    }, true);
  });

  // Get row positions
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

  // Test each row
  for (let i = 0; i < Math.min(rows.length, 7); i++) {
    const row = rows[i];
    await page.evaluate(() => { window.__pointerLog = []; });

    await page.mouse.click(row.x, row.y);
    await page.waitForTimeout(300);

    const result = await page.evaluate(() => {
      const hudWrap = document.querySelector('.fleet-hud-wrap');
      const agents = hudWrap?.querySelector('.fleet-agents-shape');
      const expanded = agents?.querySelectorAll('.fleet-agents-row.expanded').length || 0;
      return {
        log: window.__pointerLog,
        expanded,
      };
    });

    const worked = result.expanded > 0 ? '✓' : '✗';
    console.log(`\nRow ${i} (${row.text}) at (${Math.round(row.x)}, ${Math.round(row.y)}): ${worked}`);
    for (const entry of result.log) {
      console.log(`  ${entry.phase}: ${entry.element || entry.target || ''}`);
    }
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
