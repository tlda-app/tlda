import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const results = [];

function log(name, pass, detail) {
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} ${name}: ${detail}`);
  results.push({ name, pass, detail });
}

// Create test SVG upfront
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#16a34a" rx="8"/><text x="100" y="35" text-anchor="middle" fill="white" font-size="14" font-family="monospace">smoke test</text></svg>`;
const svgPath = path.resolve('data/smoke-test-image.svg');
fs.writeFileSync(svgPath, svgContent);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// ===== TEST 1: Page loads without flicker =====
await page.goto('http://localhost:5200/?_t=' + Date.now());
await page.waitForTimeout(4000);

const themeTest = await page.evaluate(() => {
  const app = document.getElementById('app');
  const body = document.body;
  return {
    appReady: app?.classList.contains('ready'),
    bodyClass: body?.className,
    bgColor: getComputedStyle(body).backgroundColor,
  };
});
log('Theme load', themeTest.appReady && themeTest.bodyClass.includes('fleet-theme-'),
  `ready=${themeTest.appReady}, body=${themeTest.bodyClass}, bg=${themeTest.bgColor}`);
await page.screenshot({ path: path.join(DIR, '1-page-load.png') });

// ===== TEST 2: Chat renders images =====
// Verify /api/file serves the SVG
const apiRes = await page.evaluate(async (p) => {
  const r = await fetch('/api/file?path=' + encodeURIComponent(p));
  return { status: r.status, type: r.headers.get('content-type') };
}, svgPath);

// Inject <img> that points to /api/file
const imgSrc = '/api/file?path=' + encodeURIComponent(svgPath);
await page.evaluate((src) => {
  const log = document.querySelector('.chat-log');
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.innerHTML = `<span class="chat-ts">4:00 AM</span> <span class="chat-nick"><span class="nick-agent-0">smoke-test:</span></span> <img class="chat-image" src="${src}" alt="smoke-test" loading="lazy">`;
  log.appendChild(line);
}, imgSrc);

await page.waitForTimeout(1500);
const imgLoaded = await page.evaluate(() => {
  const imgs = document.querySelectorAll('.chat-image');
  const last = imgs[imgs.length - 1];
  return last ? { loaded: last.complete && last.naturalWidth > 0, w: last.naturalWidth, h: last.naturalHeight } : { loaded: false };
});
log('Image rendering', apiRes.status === 200 && imgLoaded.loaded,
  `api=${apiRes.status} (${apiRes.type}), loaded=${imgLoaded.loaded}, size=${imgLoaded.w}x${imgLoaded.h}`);

await page.evaluate(() => {
  const log = document.querySelector('.chat-log');
  log.scrollTo({ top: log.scrollHeight, behavior: 'instant' });
});
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(DIR, '2-image-render.png') });

// ===== TEST 3: Enter pill shows modes =====
const agentEl = await page.$('[data-agent-id]');
if (agentEl) await agentEl.click();
await page.waitForTimeout(500);

const input = await page.$('textarea');
await input.click();

// Normal
await page.keyboard.type('test');
await page.waitForTimeout(200);
const pillNormal = await page.evaluate(() => document.querySelector('.chat-input-status')?.innerHTML);

// Interrupt
await input.fill('');
await page.keyboard.type('/interrupt');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.keyboard.type('x');
await page.waitForTimeout(200);
const pillInterrupt = await page.evaluate(() => document.querySelector('.chat-input-status')?.innerHTML);

// Queue
await input.fill('');
await page.keyboard.type('/interrupt');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
await page.keyboard.type('/queue');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.keyboard.type('x');
await page.waitForTimeout(200);
const pillQueue = await page.evaluate(() => document.querySelector('.chat-input-status')?.innerHTML);

// Clear queue
await input.fill('');
await page.keyboard.type('/queue');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);

log('Enter pill modes',
  pillNormal?.includes('send-hint-enter') && pillInterrupt?.includes('mode-interrupt') && pillQueue?.includes('mode-queue'),
  `normal=${!!pillNormal?.includes('send-hint-enter')}, interrupt=${!!pillInterrupt?.includes('mode-interrupt')}, queue=${!!pillQueue?.includes('mode-queue')}`);
await page.screenshot({ path: path.join(DIR, '3-pill-modes.png') });

// ===== TEST 4: Scroll to bottom =====
for (let i = 0; i < 8; i++) {
  await page.evaluate((i) => {
    const log = document.querySelector('.chat-log');
    const line = document.createElement('div');
    line.className = 'chat-line';
    line.innerHTML = `<span class="chat-ts">4:01 AM</span> <span class="chat-nick"><span class="nick-agent-0">smoke:</span></span> Scroll test ${i + 1}`;
    log.appendChild(line);
  }, i);
  await page.waitForTimeout(200);
}
await page.waitForTimeout(500);

const scrollGap = await page.evaluate(() => {
  const log = document.querySelector('.chat-log');
  return { gap: log.scrollHeight - log.scrollTop - log.clientHeight };
});
log('Scroll to bottom', scrollGap.gap === 0, `gap=${scrollGap.gap}`);
await page.screenshot({ path: path.join(DIR, '4-scroll.png') });

// ===== TEST 5: Agent list =====
const agentList = await page.evaluate(() => {
  const cards = document.querySelectorAll('[data-agent-id]');
  return {
    count: cards.length,
    names: Array.from(cards).map(c => c.textContent?.trim()?.substring(0, 30)),
  };
});
log('Agent list', agentList.count > 0, `${agentList.count} agents: ${agentList.names.slice(0, 5).join(', ')}`);
await page.screenshot({ path: path.join(DIR, '5-agents.png') });

// ===== TEST 6: Terminal command =====
await input.fill('');
await input.click();
await page.keyboard.type('/terminal apps');
await page.keyboard.press('Enter');
await page.waitForTimeout(1000);

const termPanel = await page.evaluate(() => {
  const term = document.querySelector('.widget-terminal, [class*="terminal"]');
  return { exists: !!term, classes: term?.className };
});
log('Terminal command', termPanel.exists, `panel=${termPanel.exists}`);
await page.screenshot({ path: path.join(DIR, '6-terminal.png') });

// ===== TEST 7: Tasks table =====
const tasksTab = await page.$('text=Tasks');
if (tasksTab) {
  await tasksTab.click();
  await page.waitForTimeout(500);
}

const tasksTable = await page.evaluate(() => {
  const rows = document.querySelectorAll('[data-task-id], .task-row, tr');
  const badges = document.querySelectorAll('.task-status, [class*="status-badge"]');
  return { rowCount: rows.length, badgeCount: badges.length, hasTable: !!document.querySelector('table') };
});
log('Tasks table', tasksTable.rowCount > 0 || tasksTable.hasTable,
  `rows=${tasksTable.rowCount}, badges=${tasksTable.badgeCount}`);
await page.screenshot({ path: path.join(DIR, '7-tasks.png') });

// ===== SUMMARY =====
console.log('\n=== SMOKE TEST SUMMARY ===');
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
console.log(`${passed} passed, ${failed} failed out of ${results.length}`);
if (failed > 0) {
  console.log('\nFailures:');
  results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.name}: ${r.detail}`));
}

fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(results, null, 2));
try { fs.unlinkSync(svgPath); } catch {}
await browser.close();
