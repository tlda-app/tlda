import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:5199');
await page.waitForTimeout(3000);

const result = await page.evaluate(() => {
  const checks = {
    hasCurrentState: typeof currentState !== 'undefined',
    HUMAN_ID_value: typeof HUMAN_ID !== 'undefined' ? HUMAN_ID : null,
  };
  if (checks.hasCurrentState && currentState?.messages) {
    const msgs = currentState.messages;
    checks.last5Messages = msgs.slice(-5).map(m => ({
      from: m.from, to: m.to, text: (m.text || '').substring(0, 60),
      timestamp: m.timestamp, _local: m._local, _failed: m._failed,
    }));
  }
  const containers = document.querySelectorAll('[data-panel-id]');
  checks.panelCount = containers.length;
  checks.panels = [...containers].map(c => ({
    id: c.dataset.panelId,
    hasLog: !!c.querySelector('.chat-log'),
    hasChatInput: !!c.querySelector('.chat-input'),
  }));
  return checks;
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
