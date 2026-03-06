import { chromium } from 'playwright';

const token = 'c5e4726ab77972fc7312f3a703f9cf1c';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', err => errors.push('PAGE_ERROR: ' + err.message));
page.on('console', msg => {
  if (msg.type() === 'error') errors.push('CONSOLE_ERROR: ' + msg.text());
});

await page.goto(`http://localhost:5176/?doc=synth-randomization&token=${token}`);
await page.waitForSelector('.tl-canvas', { timeout: 15000 });
await page.waitForTimeout(5000);

// Scroll to page 11 area (which has cross-references)
await page.evaluate(() => {
  const editor = window.__tldraw_editor__;
  if (!editor) throw new Error('No editor');
  const shapes = editor.getCurrentPageShapes();
  const svgPages = shapes.filter(s => s.type === 'svg-page' || s.type === 'image');
  console.log('Found ' + svgPages.length + ' page shapes');
  if (svgPages.length > 10) {
    const target = svgPages[10]; // page 11
    editor.centerOnPoint({ x: target.x + 300, y: target.y + 300 });
  }
});

await page.waitForTimeout(3000);

// Check for links
const linkInfo = await page.evaluate(() => {
  const links = document.querySelectorAll('[data-anchor]');
  return Array.from(links).map(l => ({
    anchor: l.getAttribute('data-anchor'),
    title: l.getAttribute('data-title'),
    text: (l.textContent || '').trim().substring(0, 40),
    visible: l.getBoundingClientRect().width > 0,
  })).filter(l => l.visible);
});
console.log('Visible links:', linkInfo.length);
if (linkInfo.length > 0) {
  console.log('First 5:', JSON.stringify(linkInfo.slice(0, 5), null, 2));
}

// Check for raw <a> elements with href still present (not stripped)
const rawHrefs = await page.evaluate(() => {
  const allAs = document.querySelectorAll('svg a');
  const withHref = Array.from(allAs).filter(a => a.getAttribute('href') || a.getAttribute('xlink:href'));
  return withHref.map(a => ({
    href: a.getAttribute('href') || a.getAttribute('xlink:href'),
    hasDataAnchor: !!a.getAttribute('data-anchor'),
  })).slice(0, 10);
});
console.log('SVG <a> with href still present:', rawHrefs.length);
if (rawHrefs.length > 0) console.log(JSON.stringify(rawHrefs, null, 2));

// Try clicking a link via dispatchEvent
if (linkInfo.length > 0) {
  const clickResult = await page.evaluate(() => {
    const links = document.querySelectorAll('[data-anchor]');
    const visible = Array.from(links).filter(l => l.getBoundingClientRect().width > 0);
    if (visible.length === 0) return 'no visible links';
    const link = visible[0];
    const rect = link.getBoundingClientRect();
    const e = new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    });
    link.dispatchEvent(e);
    return 'clicked: ' + link.getAttribute('data-anchor');
  });
  console.log('Click result:', clickResult);
  await page.waitForTimeout(2000);
}

// Check for errors
if (errors.length > 0) {
  console.log('\n=== ERRORS ===');
  errors.forEach(e => console.log(e));
} else {
  console.log('\nNo errors after click');
}

// Check ref viewer
const refViewer = await page.evaluate(() => {
  const rv = document.querySelector('.ref-viewer');
  return rv ? 'visible' : 'not found';
});
console.log('RefViewer:', refViewer);

await browser.close();
console.log('\nDone.');
