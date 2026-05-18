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

  // Click each of the first 8 rows one at a time, confirming expand
  for (let i = 0; i < 8; i++) {
    // Get fresh row positions each time (layout changes after expand)
    const row = await page.evaluate((idx) => {
      const hudWrap = document.querySelector('.fleet-hud-wrap');
      const agents = hudWrap?.querySelector('.fleet-agents-shape');
      const rows = agents?.querySelectorAll('.fleet-agents-row-main');
      if (!rows || !rows[idx]) return null;
      const r = rows[idx].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: rows[idx].textContent?.substring(0, 20) };
    }, i);

    if (!row) { console.log(`Row ${i}: not found`); continue; }
    if (row.x > 1440 || row.x < 0) { console.log(`Row ${i}: off-screen`); continue; }

    // Click
    await page.mouse.click(row.x, row.y);
    await page.waitForTimeout(600);

    // Check
    const expanded = await page.evaluate(() => {
      const hudWrap = document.querySelector('.fleet-hud-wrap');
      const agents = hudWrap?.querySelector('.fleet-agents-shape');
      return agents?.querySelectorAll('.fleet-agents-row.expanded').length || 0;
    });

    const mark = expanded > 0 ? '✓ WORKS' : '✗ BROKEN';
    console.log(`Row ${i} (${row.text?.trim()}) → ${mark}`);

    // Collapse by clicking the same row again
    await page.mouse.click(row.x, row.y);
    await page.waitForTimeout(400);
  }

  console.log('\nDone. Browser stays open for 3 minutes.');
  await page.waitForTimeout(180000);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
