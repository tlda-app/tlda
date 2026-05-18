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
  await page.setViewportSize({ width: 1800, height: 900 });

  // Capture context from /api/chat POSTs
  const captured = [];
  page.on('request', req => {
    if (req.url().includes('/api/chat') && req.method() === 'POST') {
      try { captured.push(req.postDataJSON()); } catch {}
    }
  });

  await page.goto(`${BASE}&doc=survival-draft`);
  if (!await waitForEditor(page)) { await browser.close(); return; }
  await page.waitForTimeout(2000);

  // Place a temporary fleet-chat shape right next to doc page 1
  // (page 1 is at x:0, y:0, ~800×1100 in TLDraw coords)
  const tempId = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    const docPages = ed.getCurrentPageShapes()
      .filter(s => s.type === 'svg-page' || s.type === 'html-page')
      .sort((a, b) => a.y - b.y);

    const p1 = docPages[0]; // first doc page
    const b = p1 ? ed.getShapePageBounds(p1.id) : { x: 0, y: 0, w: 800, h: 1100 };

    // Place chat just to the right of page 1
    const id = `shape:qa-ctx-demo-${Date.now()}`;
    ed.createShape({
      id,
      type: 'fleet-chat',
      x: b.x + b.w + 40,
      y: b.y + 100,
      props: { w: 340, h: 480, filter: [] }
    });
    return id;
  });
  console.log('Created temp chat:', tempId);
  await page.waitForTimeout(1500);

  // Center camera to show both page 1 and the chat shape
  await page.evaluate((id) => {
    const ed = window.__tldraw_editor__;
    const docPage = ed.getCurrentPageShapes()
      .filter(s => s.type === 'svg-page' || s.type === 'html-page')
      .sort((a, b) => a.y - b.y)[0];
    const chatShape = ed.getShape(id);
    if (!docPage || !chatShape) return;

    const pb = ed.getShapePageBounds(docPage.id);
    const cb = ed.getShapePageBounds(id);

    // Center between page and chat
    const cx = (pb.x + cb.x + cb.w) / 2;
    const cy = (pb.y + pb.h/2 + cb.y + cb.h/2) / 2;
    ed.centerOnPoint({ x: cx, y: cy }, { animation: { duration: 0 } });
    ed.setCamera({ ...ed.getCamera(), z: 0.75 }, { animation: { duration: 0 } });
  }, tempId);
  await page.waitForTimeout(500);

  // Screenshot 1: Doc page 1 + fleet chat side by side
  await page.screenshot({ path: `${OUT}/ctx-1-scene.png` });
  console.log('Screenshot 1: doc page 1 + fleet chat visible');

  // Find the textarea for the temp chat shape
  const taInfo = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('textarea')).map(t => {
      const r = t.getBoundingClientRect();
      return { ph: t.placeholder, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 50 };
    }).filter(t => t.visible);
  });
  console.log('Visible textareas:', JSON.stringify(taInfo));

  // Which pages are visible right now (context that will be captured)
  const ctxPreview = await page.evaluate(() => {
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
    return { doc: 'survival-draft', pages: visible };
  });
  console.log('Context that will be captured:', JSON.stringify(ctxPreview));

  // Type message
  if (taInfo.length > 0) {
    const ta = taInfo[0];
    await page.mouse.click(ta.x + ta.w/2, ta.y + ta.h/2);
    await page.waitForTimeout(200);
    await page.keyboard.type('what is on this page?');
    await page.waitForTimeout(300);

    // Screenshot 2: Message typed, showing doc page + context source
    await page.screenshot({ path: `${OUT}/ctx-2-typing.png` });

    // Clip to just the chat shape area
    const chatRect = await page.evaluate((id) => {
      const el = document.querySelector(`[data-shape-id="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }, tempId);
    if (chatRect) {
      await page.screenshot({
        path: `${OUT}/ctx-2-chat-clip.png`,
        clip: { x: Math.max(0, chatRect.x - 5), y: Math.max(0, chatRect.y - 5),
                 width: Math.min(chatRect.w + 10, 600), height: Math.min(chatRect.h + 10, 600) }
      });
    }
    console.log('Screenshot 2: message typed');

    // Send
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);

    // Screenshot 3: After send
    await page.screenshot({ path: `${OUT}/ctx-3-sent.png` });
    console.log('Screenshot 3: after send');

    console.log('\nCaptured API payloads:');
    for (const body of captured) {
      console.log('  message:', body.message?.slice(0, 40));
      console.log('  context:', JSON.stringify(body.context));
    }
  }

  // Clean up the temp shape
  await page.evaluate((id) => {
    const ed = window.__tldraw_editor__;
    ed.deleteShapes([id]);
  }, tempId);

  await browser.close();
  console.log('Done');
}

run().catch(e => console.error(e.message));
