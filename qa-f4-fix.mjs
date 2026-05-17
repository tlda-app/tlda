import { chromium } from 'playwright';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5176/?token=${TOKEN}`;
const OUT = '/Users/skip/work/tlda/scratch';

async function waitForEditor(page, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ready = await page.evaluate(() => !!window.__tldraw_editor__);
    if (ready) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 2000, height: 900 });
  await page.goto(`${BASE}&doc=survival-draft`);

  const editorReady = await waitForEditor(page);
  console.log('Editor ready:', editorReady);
  if (!editorReady) { await browser.close(); return; }

  // Create a fleet-chat shape with correct props
  const created = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    const vp = ed.getViewportPageBounds();
    const id = `shape:qa-fleet-chat-${Date.now()}`;
    try {
      ed.createShape({
        id,
        type: 'fleet-chat',
        x: vp.x + 50,
        y: vp.y + 50,
        props: { w: 350, h: 500, filter: [] }
      });
      return { id, success: true, x: vp.x + 50, y: vp.y + 50 };
    } catch(e) {
      return { error: e.message };
    }
  });
  console.log('Created fleet-chat:', JSON.stringify(created));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/qa-f4-chat-created.png` });

  // Find the textarea
  const taInfo = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('textarea')).map(t => {
      const r = t.getBoundingClientRect();
      return { ph: t.placeholder, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
  });
  console.log('Textareas:', JSON.stringify(taInfo));

  if (taInfo.length > 0 && taInfo[0].w > 0) {
    // Drop a file on the textarea
    const dropResult = await page.evaluate(async () => {
      const ta = Array.from(document.querySelectorAll('textarea')).find(t => {
        const r = t.getBoundingClientRect();
        return r.width > 50 && r.height > 10;
      });
      if (!ta) return { error: 'no visible textarea' };

      const file = new File(['# Test content'], 'qa-drag-test.md', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);

      ta.focus();
      ta.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 300));
      ta.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 300));
      ta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 6000));

      const r = ta.getBoundingClientRect();
      return {
        placeholder: ta.placeholder,
        value: ta.value.slice(0, 300),
        pos: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }
      };
    });
    console.log('Drop result:', JSON.stringify(dropResult));
    await page.screenshot({ path: `${OUT}/qa-f4-drop-final.png` });

    if (dropResult.value && (dropResult.value.includes('http') || dropResult.value.includes('api/files'))) {
      console.log('F4 PASS: Upload link appeared in textarea');
    } else {
      console.log('F4: Link not in textarea. Value:', dropResult.value?.slice(0, 100));
    }
  } else {
    console.log('No visible textarea found. Checking DOM:');
    const dom = await page.evaluate((id) => {
      const el = document.getElementById(id) || document.querySelector(`[data-shape-id="${id}"]`);
      return el ? el.innerHTML.slice(0, 500) : 'shape element not found';
    }, created.id);
    console.log('Shape HTML:', dom.slice(0, 300));
    await page.screenshot({ path: `${OUT}/qa-f4-no-textarea.png` });
  }

  await browser.close();
}

run().catch(e => console.error(e.message));
