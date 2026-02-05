const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Disable cache
  await page.setCacheEnabled(false);

  page.on('console', msg => console.log('[Browser]', msg.text()));
  page.on('pageerror', err => console.log('[Error]', err.message));

  console.log('Loading page (cache disabled)...');
  await page.goto('https://claude-tldraw.vercel.app/?doc=bregman&room=test-review', {
    waitUntil: 'networkidle0',
    timeout: 30000
  });

  await new Promise(r => setTimeout(r, 4000));

  const content = await page.evaluate(() => {
    return {
      hasTldraw: document.querySelector('.tl-container') !== null,
      shapeCount: window.__tldraw_editor__?.getCurrentPageShapes()?.length || 0,
    };
  });

  console.log('Result:', JSON.stringify(content, null, 2));

  await browser.close();
})();
