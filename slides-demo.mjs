#!/usr/bin/env node
/**
 * Slides mode playback demo — navigates imagined-rand talk,
 * captures screenshots showing camera animation, fragment stepping, navigator.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'http://localhost:5176';
const DOC = 'imagined-rand';
const TOKEN = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.config/tlda/config.json'), 'utf8')).token;
const OUT = '/tmp/slides-demo';

// Clean previous run
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let shotIdx = 0;
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function shot(page, label) {
  shotIdx++;
  const name = String(shotIdx).padStart(2, '0');
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`📸 ${name}: ${label}`);
  return file;
}

// Wait for the navigator counter to stabilize
async function getNavigator(page) {
  try {
    const text = await page.locator('.slides-navigator-counter, [class*="navigator"] span, .slides-nav').first().textContent({ timeout: 2000 });
    return text?.trim() || '';
  } catch { return ''; }
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();

  // Navigate to slides doc
  await page.goto(`${BASE}/?doc=${DOC}&token=${TOKEN}`);
  await page.waitForSelector('.tl-canvas', { timeout: 15000 });
  await sleep(4000); // Let title slide iframe load fully

  await shot(page, 'Title slide — "Inference Based on Imagined Randomization" (1/27)');

  // Navigate through first section slowly — show camera animation
  console.log('\n--- Camera animation between slides ---');

  await page.keyboard.press('ArrowRight');
  await sleep(2000);
  await shot(page, 'Slide 2 — "How We Talk About Randomness" — camera animated right');

  await page.keyboard.press('ArrowRight');
  await sleep(2000);
  await shot(page, 'Slide 3 — "Two stories we tell undergrads"');

  await page.keyboard.press('ArrowRight');
  await sleep(2000);
  await shot(page, 'Slide 4 — "A poll" with histogram and math');

  await page.keyboard.press('ArrowRight');
  await sleep(2000);
  await shot(page, 'Slide 5 — "Calibrating the interval"');

  // Navigate into "An Experiment" section
  await page.keyboard.press('ArrowRight');
  await sleep(2500);
  await shot(page, 'Slide 6 — "An Experiment" (new section)');

  await page.keyboard.press('ArrowRight');
  await sleep(2500);
  await shot(page, 'Slide 7 — "The social pressure mailer"');

  await page.keyboard.press('ArrowRight');
  await sleep(2500);
  await shot(page, 'Slide 8 — "Potential outcomes"');

  // Slides 9-10 likely have fragments (Sampling/Randomization sections)
  // Navigate and try fragment stepping
  console.log('\n--- Fragment stepping ---');

  await page.keyboard.press('ArrowRight');
  await sleep(2500);
  await shot(page, 'Slide 9 — "The randomization distribution"');

  // Keep pressing ArrowRight — if there are fragments, we'll step through them
  // before advancing to the next slide. The navigator will show (1/N) for fragments.
  await page.keyboard.press('ArrowRight');
  await sleep(1500);
  await shot(page, 'ArrowRight — fragment step or next slide');

  await page.keyboard.press('ArrowRight');
  await sleep(1500);
  await shot(page, 'ArrowRight — continuing through fragments/slides');

  await page.keyboard.press('ArrowRight');
  await sleep(1500);
  await shot(page, 'ArrowRight — "The parallel" or fragment step');

  // Show backward navigation
  console.log('\n--- Backward navigation ---');
  await page.keyboard.press('ArrowLeft');
  await sleep(1500);
  await shot(page, 'ArrowLeft — navigated backward');

  // Jump forward to the "Imagined Randomization" section (slide 17+)
  console.log('\n--- Jumping to later section ---');
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('ArrowRight');
    await sleep(300);
  }
  await sleep(3000); // Let the target slide load
  await shot(page, 'Jumped to "Imagined Randomization" section');

  // Navigate through a few more in this section
  await page.keyboard.press('ArrowRight');
  await sleep(2500);
  await shot(page, '"The core idea"');

  await page.keyboard.press('ArrowRight');
  await sleep(2500);
  await shot(page, '"What we\'re imagining"');

  await page.keyboard.press('ArrowRight');
  await sleep(2500);
  await shot(page, '"The key quantity: T_eff"');

  // Navigate to end
  console.log('\n--- Navigating to end ---');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('ArrowRight');
    await sleep(400);
  }
  await sleep(2500);
  await shot(page, 'Near the end of the talk');

  // Last slide
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowRight');
    await sleep(400);
  }
  await sleep(2500);
  await shot(page, 'Final slide — References (27/27)');

  console.log(`\n✅ Demo complete. ${shotIdx} screenshots in ${OUT}/`);

  await context.close(); // Flush video
  await browser.close();

  // List outputs
  const files = fs.readdirSync(OUT).sort();
  const pngs = files.filter(f => f.endsWith('.png'));
  const vids = files.filter(f => f.endsWith('.webm'));
  console.log(`Screenshots: ${pngs.length}`);
  pngs.forEach(f => console.log(`  ${f}`));
  if (vids.length) console.log(`Video: ${path.join(OUT, vids[0])}`);
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
