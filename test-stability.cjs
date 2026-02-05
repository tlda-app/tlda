const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.setCacheEnabled(false);

  page.on('console', msg => console.log('[Browser]', msg.text()));
  page.on('pageerror', err => console.log('[PageError]', err.message));
  page.on('error', err => console.log('[Error]', err.message));

  console.log('Loading page...');
  await page.goto('https://claude-tldraw.vercel.app/?doc=bregman&room=test-review', {
    waitUntil: 'networkidle0',
    timeout: 30000
  });

  console.log('Page loaded, monitoring for 60 seconds...');

  // Check every 5 seconds for 60 seconds
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const content = await page.evaluate(() => {
      return {
        hasTldraw: document.querySelector('.tl-container') !== null,
        hasError: document.querySelector('.ErrorScreen') !== null,
        bodyHTML: document.body.innerHTML.substring(0, 200),
      };
    });

    console.log(`[${(i+1)*5}s] TLDraw: ${content.hasTldraw}, Error: ${content.hasError}`);

    if (!content.hasTldraw && !content.hasError) {
      console.log('Page went blank! Body:', content.bodyHTML);
      break;
    }
    if (content.hasError) {
      console.log('Error screen shown!');
      break;
    }
  }

  await browser.close();
  console.log('Done');
})();
