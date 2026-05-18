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

  // Intercept outgoing API requests to /api/message or /api/send
  const capturedRequests = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('/api/message') || url.includes('/api/send') || url.includes('/api/chat')) {
      try {
        const body = req.postDataJSON();
        capturedRequests.push({ url, body });
        console.log('Intercepted:', url, JSON.stringify(body).slice(0, 200));
      } catch {}
    }
  });

  await page.goto(`${BASE}&doc=survival-draft`);
  if (!await waitForEditor(page)) { console.log('No editor'); await browser.close(); return; }
  await page.waitForTimeout(2000);

  // Scroll to page 3 of the document to get a specific page context
  await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    // Find page 3 shape if it exists
    const shapes = ed.getCurrentPageShapes();
    const pageShapes = shapes.filter(s => s.type === 'svg-page' || s.type === 'html-page');
    if (pageShapes.length >= 3) {
      const p3 = pageShapes[2];
      const b = ed.getShapePageBounds(p3.id);
      if (b) ed.centerOnPoint({ x: b.x + b.w/2, y: b.y + b.h/2 }, { animation: { duration: 0 } });
    }
  });
  await page.waitForTimeout(500);

  // Screenshot 1: App loaded, viewing doc
  await page.screenshot({ path: `${OUT}/ctx-01-app-loaded.png` });
  console.log('Screenshot 1: app loaded');

  // Find fleet-chat shape and create one if needed
  const chatInfo = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    const shapes = ed.getCurrentPageShapes().filter(s => s.type === 'fleet-chat');
    if (shapes.length > 0) {
      const b = ed.getShapePageBounds(shapes[0].id);
      return { existing: true, id: shapes[0].id, x: b?.x, y: b?.y };
    }
    // Create one
    const vp = ed.getViewportPageBounds();
    const id = `shape:qa-ctx-chat-${Date.now()}`;
    ed.createShape({ id, type: 'fleet-chat', x: vp.x + 20, y: vp.y + 20, props: { w: 320, h: 450, filter: [] } });
    return { existing: false, id };
  });
  console.log('Chat shape:', chatInfo);
  await page.waitForTimeout(1500);

  // Center camera to show the fleet chat shape
  await page.evaluate((id) => {
    const ed = window.__tldraw_editor__;
    const shape = ed.getShape(id);
    if (shape) {
      const b = ed.getShapePageBounds(id);
      if (b) ed.centerOnPoint({ x: b.x + b.w/2, y: b.y + b.h/2 }, { animation: { duration: 0 } });
      ed.setCamera({ ...ed.getCamera(), z: 0.9 }, { animation: { duration: 0 } });
    }
  }, chatInfo.id);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/ctx-02-chat-visible.png` });

  // Find the textarea
  const taInfo = await page.evaluate(() => {
    const tas = Array.from(document.querySelectorAll('textarea')).filter(t => {
      const r = t.getBoundingClientRect();
      return r.width > 50 && r.height > 10;
    });
    return tas.map(t => {
      const r = t.getBoundingClientRect();
      return { ph: t.placeholder, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    });
  });
  console.log('Visible textareas:', JSON.stringify(taInfo));

  // Get the current viewer context that would be captured
  const viewerCtx = await page.evaluate(() => {
    const ed = window.__tldraw_editor__;
    if (!ed) return null;
    const camera = ed.getCamera();
    const viewport = ed.getViewportPageBounds();
    const pageShapes = ed.getCurrentPageShapes().filter(s => s.type === 'svg-page' || s.type === 'html-page');
    const visiblePages = [];
    pageShapes.forEach((s, i) => {
      const b = ed.getShapePageBounds(s.id);
      if (b && b.x + b.w > viewport.minX && b.x < viewport.maxX &&
          b.y + b.h > viewport.minY && b.y < viewport.maxY) {
        visiblePages.push(i + 1);
      }
    });
    return {
      camera: { x: Math.round(camera.x), y: Math.round(camera.y), z: camera.z },
      visiblePages,
      viewportBounds: { minX: Math.round(viewport.minX), minY: Math.round(viewport.minY),
                        maxX: Math.round(viewport.maxX), maxY: Math.round(viewport.maxY) },
    };
  });
  console.log('Viewer context (expected in message):', JSON.stringify(viewerCtx));

  // Send a message via the textarea
  const testMsg = `qa-context-tag-test-${Date.now()}`;
  const sent = await page.evaluate(async (msg) => {
    const ta = Array.from(document.querySelectorAll('textarea')).find(t => {
      const r = t.getBoundingClientRect();
      return r.width > 50 && r.height > 10;
    });
    if (!ta) return { error: 'no textarea' };

    // Focus and type
    ta.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(ta, msg);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    // Press Enter to send
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 2000));
    return { sent: true, placeholder: ta.placeholder, value: ta.value };
  }, testMsg);
  console.log('Send result:', JSON.stringify(sent));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/ctx-03-after-send.png` });

  console.log('\nCaptured API requests:', capturedRequests.length);
  for (const r of capturedRequests) {
    console.log('  URL:', r.url);
    console.log('  Body:', JSON.stringify(r.body));
  }

  // Also check via fleet API directly
  console.log('\nChecking fleet server for recent messages...');
  const recentMsgs = await page.evaluate(async (msg) => {
    try {
      // Try to get recent messages from fleet server
      const r = await fetch('http://localhost:5199/api/messages?limit=5');
      if (!r.ok) return { error: r.status };
      return await r.json();
    } catch(e) {
      return { error: e.message };
    }
  }, testMsg);
  console.log('Fleet messages:', JSON.stringify(recentMsgs).slice(0, 500));

  await browser.close();
  console.log('\n=== Done ===');
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
