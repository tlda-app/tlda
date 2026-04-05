import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:5200/');
await page.waitForTimeout(8000);
const info = await page.evaluate(() => ({
  dockview: !!document.querySelector('.fleet-dockview'),
  chatWidgets: document.querySelectorAll('.chat-widget').length,
  agentItems: document.querySelectorAll('.agent-item, .agents-table tr').length,
  bodyLen: document.body.innerHTML.length,
}));
await page.screenshot({ path: '/tmp/dashboard-final.png' });
console.log(JSON.stringify({ errors, ...info }));
await browser.close();
