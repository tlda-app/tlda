import { chromium } from 'playwright';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5176/?token=${TOKEN}`;
const OUT = '/Users/skip/work/tlda/scratch';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 2000, height: 900 });

  // Capture console errors
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 100)); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message.slice(0, 100)));

  await page.goto(`${BASE}&doc=survival-draft`);
  console.log('Navigated');

  // Check state at various intervals
  for (let i = 1; i <= 15; i++) {
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => ({
      title: document.title,
      bodyText: document.body.innerText?.slice(0, 50),
      hasEditor: !!window.__tldraw_editor__,
      shapesInDOM: document.querySelectorAll('.tl-shape').length,
      textareas: document.querySelectorAll('textarea').length,
    }));
    console.log(`t=${i}s:`, JSON.stringify(state));
    if (state.hasEditor) {
      console.log('EDITOR READY at', i, 's');
      break;
    }
  }

  console.log('Errors:', errors.slice(0, 5));
  await page.screenshot({ path: `${OUT}/qa-debug.png` });
  await browser.close();
}

run().catch(e => console.error(e.message));
