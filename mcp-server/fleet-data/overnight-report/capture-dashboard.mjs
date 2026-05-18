import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const DIR = path.dirname(new URL(import.meta.url).pathname);

// Create test SVG for image rendering
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><rect width="300" height="80" fill="#2563eb" rx="8"/><text x="150" y="45" text-anchor="middle" fill="white" font-size="16" font-family="monospace">fleet image render test</text></svg>`;
const svgPath = path.resolve('data/overnight-report/test-image.svg');
fs.writeFileSync(svgPath, svgContent);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// === 4. Theme on load — early screenshot ===
await page.goto('http://localhost:5200/?_t=' + Date.now());
// Screenshot as early as possible
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(DIR, '04-theme-early.png') });
console.log('4. Theme early screenshot');

await page.waitForTimeout(3500);

// === 5. Agent list ===
await page.screenshot({ path: path.join(DIR, '05-agent-list.png') });
console.log('5. Agent list');

// === 1. Image rendering in chat ===
const imgSrc = '/api/file?path=' + encodeURIComponent(svgPath);
await page.evaluate((src) => {
  const log = document.querySelector('.chat-log');
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.innerHTML = `<span class="chat-ts">4:15 AM</span> <span class="chat-nick"><span class="nick-agent-0">demo:</span></span> Here's my screenshot: <img class="chat-image" src="${src}" alt="test" loading="lazy">`;
  log.appendChild(line);
  log.scrollTo({ top: log.scrollHeight, behavior: 'instant' });
}, imgSrc);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(DIR, '01-image-render.png') });
console.log('1. Image rendering');

// === 2. Enter pill modes ===
// Click agent to set target
const agentEl = await page.$('[data-agent-id]');
if (agentEl) await agentEl.click();
await page.waitForTimeout(500);

const input = await page.$('textarea');
await input.click();

// Normal pill
await page.keyboard.type('sending a message');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(DIR, '02a-pill-normal.png') });
console.log('2a. Normal pill');

// Interrupt pill
await input.fill('');
await page.keyboard.type('/interrupt');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.keyboard.type('interrupt message');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(DIR, '02b-pill-interrupt.png') });
console.log('2b. Interrupt pill');

// Queue pill
await input.fill('');
await page.keyboard.type('/interrupt');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
await page.keyboard.type('/queue');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.keyboard.type('queued message');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(DIR, '02c-pill-queue.png') });
console.log('2c. Queue pill');

// Clear queue
await input.fill('');
await page.keyboard.type('/queue');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);

// === 3. Scroll to bottom ===
for (let i = 0; i < 12; i++) {
  await page.evaluate((i) => {
    const log = document.querySelector('.chat-log');
    const line = document.createElement('div');
    line.className = 'chat-line';
    line.innerHTML = `<span class="chat-ts">4:16 AM</span> <span class="chat-nick"><span class="nick-agent-0">scroll-test:</span></span> Message ${i + 1} — chat should scroll to show this line with zero gap`;
    log.appendChild(line);
  }, i);
  await page.waitForTimeout(150);
}
await page.waitForTimeout(500);
const gap = await page.evaluate(() => {
  const log = document.querySelector('.chat-log');
  return log.scrollHeight - log.scrollTop - log.clientHeight;
});
console.log('3. Scroll gap:', gap);
await page.screenshot({ path: path.join(DIR, '03-scroll-bottom.png') });

// === 6. Terminal ===
await input.fill('');
await input.click();
await page.keyboard.type('/terminal apps');
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(DIR, '06-terminal.png') });
console.log('6. Terminal');

// === 7. Tasks table ===
// Switch back to Chat+Tasks view
const tasksTab = await page.$('.dv-default-tab:has-text("Tasks")');
if (tasksTab) {
  await tasksTab.click();
  await page.waitForTimeout(500);
}
// Also try clicking the Tasks tab in the tab bar
const allTabs = await page.$$('.dv-default-tab');
for (const tab of allTabs) {
  const text = await tab.textContent();
  if (text?.includes('Tasks')) {
    await tab.click();
    await page.waitForTimeout(500);
    break;
  }
}
await page.screenshot({ path: path.join(DIR, '07-tasks-table.png') });
console.log('7. Tasks table');

await browser.close();
console.log('\nDashboard screenshots complete');
