import { chromium } from 'playwright';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5176/?token=${TOKEN}`;
const OUT = '/Users/skip/work/tlda/scratch';

async function waitForEditor(page, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(() => !!window.__tldraw_editor__)) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 2000, height: 900 });
  await page.goto(`${BASE}&doc=survival-draft`);

  if (!await waitForEditor(page)) { console.log('No editor'); await browser.close(); return; }

  // Create a fleet-chat shape at a visible position
  const created = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    const vp = ed.getViewportPageBounds();
    const id = `shape:qa-fleet-chat-${Date.now()}`;
    ed.createShape({ id, type: 'fleet-chat', x: vp.x + 50, y: vp.y + 50, props: { w: 350, h: 450, filter: [] } });
    return { id };
  });
  console.log('Created shape:', created.id);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/qa-f4-v3-created.png` });

  // Find the textarea to get its placeholder (tells us which shape is focused)
  const taInfo = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('textarea')).map(t => {
      const r = t.getBoundingClientRect();
      return { ph: t.placeholder, x: r.x, y: r.y, w: r.width, h: r.height };
    });
  });
  console.log('Textareas:', JSON.stringify(taInfo));

  // Dispatch drop on the shape container
  const dropResult = await page.evaluate(async (shapeId) => {
    // Find the shape container — it has data-shape-id attribute
    const shapeEl = document.querySelector(`[data-shape-id="${shapeId}"]`);
    if (!shapeEl) return { error: `shape element not found: ${shapeId}` };

    // Find the inner container (shapeContainerRef)
    // The drop handler is on the first child div with the class
    const container = shapeEl.querySelector('[class*="fleet-chat"]') || shapeEl.firstElementChild || shapeEl;
    console.log('Drop target:', container?.className?.slice(0, 50));

    // Before drop: capture textarea value
    const ta = document.querySelector('textarea');
    const beforeVal = ta ? ta.value : '(no textarea)';

    // Create a file and drop event
    const file = new File(['# Test drop\nContent here'], 'qa-drop-test.md', { type: 'text/markdown' });
    const dt = new DataTransfer();
    dt.items.add(file);

    // Types should include 'Files'
    console.log('DataTransfer types:', [...dt.types]);

    // Dispatch on the shape element (where the capture-phase handler is)
    shapeEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 200));
    shapeEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 6000));

    // After drop: check textarea
    const afterVal = ta ? ta.value : '(no textarea)';
    return {
      types: [...dt.types],
      beforeVal, afterVal,
      shape: { tag: shapeEl.tagName, cls: shapeEl.className?.slice(0, 50) }
    };
  }, created.id);
  console.log('Drop result:', JSON.stringify(dropResult));
  await page.screenshot({ path: `${OUT}/qa-f4-v3-result.png` });

  await browser.close();
}

run().catch(e => console.error(e.message));
