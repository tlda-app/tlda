import { chromium } from 'playwright';

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c';
const BASE = `http://localhost:5179/?token=${TOKEN}`;
const OUT = '/Users/skip/work/tlda/scratch';

async function waitForEditor(page, timeout = 12000) {
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
  await page.setViewportSize({ width: 1600, height: 900 });

  // Capture /api/chat POST requests
  const capturedCtx = [];
  page.on('request', req => {
    if (req.url().includes('/api/chat') && req.method() === 'POST') {
      try {
        const body = req.postDataJSON();
        if (body?.context) capturedCtx.push(body);
      } catch {}
    }
  });

  await page.goto(`${BASE}&doc=survival-draft`);
  if (!await waitForEditor(page)) { await browser.close(); return; }
  await page.waitForTimeout(2000);

  // Build a scene: zoom to page 3 of the document, with fleet chat visible
  const sceneResult = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;

    // Find existing fleet-chat shapes
    const chatShapes = ed.getCurrentPageShapes().filter(s => s.type === 'fleet-chat');
    const docPages = ed.getCurrentPageShapes().filter(s =>
      s.type === 'svg-page' || s.type === 'html-page'
    ).sort((a, b) => a.y - b.y); // sort by Y position

    // Target: show page 3 of doc, with fleet chat in viewport
    const targetPage = docPages[2]; // 0-indexed → page 3
    const chatShape = chatShapes[0];

    if (!targetPage || !chatShape) {
      return { error: 'missing shapes', docPages: docPages.length, chatShapes: chatShapes.length };
    }

    const pb = ed.getShapePageBounds(targetPage.id);
    const cb = ed.getShapePageBounds(chatShape.id);

    // Center between the two
    const cx = (pb.x + pb.w/2 + cb.x + cb.w/2) / 2;
    const cy = (pb.y + pb.h/2 + cb.y + cb.h/2) / 2;
    ed.centerOnPoint({ x: cx, y: cy }, { animation: { duration: 0 } });
    ed.setCamera({ ...ed.getCamera(), z: 0.65 }, { animation: { duration: 0 } });

    return {
      docPage3: { x: Math.round(pb.x), y: Math.round(pb.y), w: Math.round(pb.w) },
      chatShape: { id: chatShape.id.slice(-8), x: Math.round(cb.x), y: Math.round(cb.y) },
    };
  });
  console.log('Scene:', JSON.stringify(sceneResult));
  await page.waitForTimeout(600);

  // Screenshot 1: Document page 3 + fleet chat in view
  await page.screenshot({ path: `${OUT}/ctx-A-scene.png` });
  console.log('Screenshot A: doc page + fleet chat visible');

  // Check which pages are currently visible (what context will be captured)
  const preCtx = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    const viewport = ed.getViewportPageBounds();
    const docPages = ed.getCurrentPageShapes()
      .filter(s => s.type === 'svg-page' || s.type === 'html-page')
      .sort((a, b) => a.y - b.y);
    const visible = [];
    docPages.forEach((s, i) => {
      const b = ed.getShapePageBounds(s.id);
      if (b && b.x + b.w > viewport.minX && b.x < viewport.maxX &&
          b.y + b.h > viewport.minY && b.y < viewport.maxY) {
        visible.push(i + 1);
      }
    });
    return { visiblePages: visible, doc: 'survival-draft' };
  });
  console.log('Pre-send context:', JSON.stringify(preCtx));

  // Find the textarea and type + send a message
  const taRect = await page.evaluate(() => {
    const ta = Array.from(document.querySelectorAll('textarea')).find(t => {
      const r = t.getBoundingClientRect();
      return r.width > 50 && r.height > 10;
    });
    if (!ta) return null;
    const r = ta.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), ph: ta.placeholder };
  });
  console.log('Textarea:', JSON.stringify(taRect));

  if (taRect) {
    // Click textarea and type
    await page.mouse.click(taRect.x + taRect.w/2, taRect.y + taRect.h/2);
    await page.waitForTimeout(200);

    // Type the message
    await page.keyboard.type('what page am I on?');
    await page.waitForTimeout(300);

    // Screenshot 2: Message typed in textarea, doc page visible
    await page.screenshot({ path: `${OUT}/ctx-B-typing.png` });
    console.log('Screenshot B: message typed');

    // Clip to just the fleet chat area
    const chatRect = await page.evaluate(() => {
      const el = document.querySelector('[data-shape-type="fleet-chat"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    if (chatRect) {
      await page.screenshot({
        path: `${OUT}/ctx-B-chat-clip.png`,
        clip: { x: Math.max(0, chatRect.x - 5), y: Math.max(0, chatRect.y - 5),
                 width: Math.min(chatRect.w + 10, 800), height: Math.min(chatRect.h + 10, 800) }
      });
    }

    // Send via Enter
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);

    // Screenshot 3: After send - message cleared, context captured
    await page.screenshot({ path: `${OUT}/ctx-C-sent.png` });
    console.log('Screenshot C: message sent');

    console.log('\nCaptured context payloads:');
    for (const body of capturedCtx) {
      console.log('  context:', JSON.stringify(body.context));
      console.log('  to:', body.to, '| message:', body.message?.slice(0, 40));
    }
  }

  await browser.close();
  console.log('Done');
}

run().catch(e => console.error(e.message));
