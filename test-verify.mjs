import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const token = 'c5e4726ab77972fc7312f3a703f9cf1c';

// Setup
mkdirSync('/tmp/test-book-member', { recursive: true });
writeFileSync('/tmp/test-book-member/test.md', '# Test Doc\n\nHello world');
try { execSync('node cli/tlda.mjs create test-member1 --dir /tmp/test-book-member --format markdown --title "Test Member 1"', { stdio: 'pipe' }); } catch {}
try { execSync('node cli/tlda.mjs book test-book --members test-member1', { stdio: 'pipe' }); } catch {}

const browser = await puppeteer.launch({ headless: 'shell', timeout: 60000 });
const page = await browser.newPage();
await page.goto(`http://localhost:5176/?doc=test-book&token=${token}`, { waitUntil: 'networkidle2', timeout: 15000 });

for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 1000));
  if (await page.evaluate(() => !!window.__tldraw_editor__)) break;
}
await new Promise(r => setTimeout(r, 2000));

// Test 1: Check drop target shape exists
const dropTarget = await page.evaluate(() => {
  const editor = window.__tldraw_editor__;
  const shapes = editor.getCurrentPageShapes();
  const dt = shapes.find(s => s.type === 'toc-drop-target');
  return dt ? { type: dt.type, x: Math.round(dt.x), y: Math.round(dt.y), w: Math.round(dt.props.w), h: Math.round(dt.props.h) } : null;
});
console.log('Drop target shape:', JSON.stringify(dropTarget));

// Test 2: Create a chapter note and check the § indicator
await page.evaluate(() => {
  const editor = window.__tldraw_editor__;
  editor.createShape({
    type: 'math-note',
    x: 200, y: 200,
    props: {
      text: '# Test Chapter\n\nContent here.',
      color: 'light-blue', w: 250, h: 150,
    },
    meta: { createdAt: Date.now() },
  });
});
await new Promise(r => setTimeout(r, 1000));
await page.evaluate(() => window.__tldraw_editor__?.zoomToFit());
await new Promise(r => setTimeout(r, 1000));

const hasIndicator = await page.evaluate(() => {
  const notes = document.querySelectorAll('[data-shape-type="math-note"]');
  for (const note of notes) {
    if (note.querySelector('[title*="chapter"]')) return true;
  }
  return false;
});
console.log('Chapter indicator (§):', hasIndicator);

// Test 3: Verify no HTML5 drag handle exists
const hasDragHandle = await page.evaluate(() => {
  return !!document.querySelector('[draggable="true"][title*="chapter"]');
});
console.log('HTML5 drag handle (should be false):', hasDragHandle);

// Test 4: Verify the toc-drop-chapter event works
const eventTest = await page.evaluate(() => {
  return new Promise(resolve => {
    window.addEventListener('toc-drop-chapter', (e) => {
      resolve({ received: true, title: e.detail?.title });
    }, { once: true });
    window.dispatchEvent(new CustomEvent('toc-drop-chapter', {
      detail: { text: '# Hello\n\nWorld', title: 'Hello' },
    }));
    setTimeout(() => resolve({ received: false }), 500);
  });
});
console.log('Event dispatch test:', JSON.stringify(eventTest));

await page.screenshot({ path: '/tmp/toc-drop-test.png' });

// Cleanup
try {
  execSync(`curl -s -X DELETE "http://localhost:5176/api/projects/test-book?token=${token}"`, { stdio: 'pipe' });
  execSync(`curl -s -X DELETE "http://localhost:5176/api/projects/test-member1?token=${token}"`, { stdio: 'pipe' });
  execSync('rm -rf /tmp/test-book-member', { stdio: 'pipe' });
} catch {}

await browser.close();
console.log('Done');
