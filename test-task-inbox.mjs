/**
 * TaskInboxShape visual verification test
 * Uses playwright to test the shape with mock inbox data
 */
import { chromium } from 'playwright'
import { spawn } from 'child_process'
import { mkdir, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

const WORKTREE = '/Users/skip/work/tlda/.worktrees/task-inbox'
const PREVIEW_PORT = 5180
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`
const SCREENSHOTS_DIR = '/tmp/task-inbox-shots'
const REPORT_OUTPUT_DIR = '/Users/skip/work/tlda/server/projects/scratch-task-inbox-report/output'

// Mock inbox items with various states
const MOCK_ITEMS = [
  {
    id: 'task-abc123',
    description: 'Write visual report for TaskInboxShape — verify all features with screenshots and evidence',
    agent_name: 'qa-verifier',
    completed_at: new Date(Date.now() - 7 * 60000).toISOString(),
    success_criteria: [
      'Report at scratch/task-inbox-report.md with inline screenshots',
      'Every feature has visual evidence',
      'Images render in the tlda viewer',
      'No empty frames or placeholder screenshots',
    ],
    message: 'Full task context: place the shape on a fresh doc, interact with it (approve/reject), capture all states with real content.',
    qa: {
      has_report: true,
      signatures: [
        { verdict: 'approved', agent_id: 'fleet:a1b2c3', notes: 'all criteria met' },
      ],
      report: {
        fields: {
          task_type: 'verification',
          screenshots: '8',
          features_tested: 'inbox display, navigation, approve, reject, empty state',
        },
      },
    },
  },
  {
    id: 'task-def456',
    description: 'Implement fleet agent heartbeat with exponential backoff and reconnect logic',
    agent_name: 'chip-fixer',
    completed_at: new Date(Date.now() - 45 * 60000).toISOString(),
    success_criteria: [
      'Reconnects within 5s after connection drop',
      'Exponential backoff caps at 30s',
      'Heartbeat visible in fleet dashboard',
    ],
    message: null,
    qa: {
      has_report: true,
      signatures: [
        { verdict: 'rejected', agent_id: 'fleet:x9y8z7', notes: 'backoff not capped correctly' },
      ],
      report: { fields: { task_type: 'implementation', test_coverage: '60%' } },
    },
  },
  {
    id: 'task-ghi789',
    description: 'Fix voice send button disappearing after silence timeout in mobile Safari',
    agent_name: 'voice-debugger',
    completed_at: new Date(Date.now() - 2 * 3600000).toISOString(),
    success_criteria: ['Button visible after 30s silence', 'Works in WebKit playwright'],
    message: 'Voice send button used display:none; should be visibility:hidden to keep layout. Fixed in voice.mjs line 234.',
    qa: {
      has_report: false,
      signatures: [],
    },
  },
]

async function waitForPort(port, maxMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const { default: http } = await import('http')
      await new Promise((res, rej) => {
        const req = http.get(`http://localhost:${port}/`, r => { r.destroy(); res() })
        req.on('error', rej)
        req.setTimeout(800, () => rej(new Error('timeout')))
      })
      return true
    } catch { await new Promise(r => setTimeout(r, 600)) }
  }
  return false
}

async function run() {
  await mkdir(SCREENSHOTS_DIR, { recursive: true })
  await mkdir(REPORT_OUTPUT_DIR, { recursive: true })

  console.log('Starting vite preview from worktree...')
  const vite = spawn('npm', ['run', 'preview', '--', '--port', String(PREVIEW_PORT)], {
    cwd: WORKTREE,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stdout.on('data', d => process.stdout.write(d))
  vite.stderr.on('data', d => process.stderr.write(d))

  const ready = await waitForPort(PREVIEW_PORT, 20000)
  if (!ready) throw new Error('vite preview did not start in time')
  console.log(`vite preview ready at ${PREVIEW_URL}`)

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  // Track current mock state
  let mockItems = [...MOCK_ITEMS]

  // Intercept fleet API calls
  await page.route('http://localhost:5199/api/inbox', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockItems),
    })
  })
  await page.route('http://localhost:5199/api/inbox/action', async route => {
    const body = JSON.parse(route.request().postData() || '{}')
    console.log('Action:', body.action, 'on', body.task_id)
    mockItems = mockItems.filter(i => i.id !== body.task_id)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })

  page.on('pageerror', err => console.error('Page error:', err.message.slice(0, 80)))

  // Navigate to fresh room
  const roomUrl = `${PREVIEW_URL}/?doc=test-inbox-verification`
  console.log(`Navigating to ${roomUrl}`)
  await page.goto(roomUrl, { waitUntil: 'networkidle', timeout: 30000 })

  // Wait for TLDraw editor to mount
  await page.waitForFunction(() => !!window.__tldraw_editor__, { timeout: 20000 })
  console.log('TLDraw editor ready')

  // Place TaskInboxShape
  await page.evaluate(() => {
    const editor = window.__tldraw_editor__
    const bounds = editor.getViewportScreenBounds()
    editor.createShape({
      id: 'shape:task-inbox-test-1',
      type: 'task-inbox',
      x: bounds.w / 2 - 240,
      y: bounds.h / 2 - 260,
      props: { w: 480, h: 520 },
    })
    editor.zoomToFit()
  })

  await page.waitForTimeout(2000) // React render + fetch

  // Shot 1: Full canvas view showing shape placed
  let shot = path.join(SCREENSHOTS_DIR, '01-initial-full-canvas.png')
  await page.screenshot({ path: shot })
  console.log('Shot 1: initial full canvas')

  // Find the shape element
  const shapeEl = await page.$('[data-shape-type="task-inbox"]')
  if (!shapeEl) {
    console.error('ERROR: shape element not found in DOM!')
    // Take a diagnostic shot
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'diagnostic.png') })
    throw new Error('TaskInboxShape not found in DOM')
  }

  const box = await shapeEl.boundingBox()
  if (!box) throw new Error('Shape has no bounding box')
  console.log(`Shape at x=${box.x.toFixed(0)}, y=${box.y.toFixed(0)}, w=${box.width.toFixed(0)}, h=${box.height.toFixed(0)}`)

  const clip = { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 }

  // Shot 2: Shape closeup — 3 items, QA approved badge, success criteria, message
  shot = path.join(SCREENSHOTS_DIR, '02-item1-approved-qa.png')
  await page.screenshot({ path: shot, clip })
  console.log('Shot 2: item 1 (approved QA badge, criteria, message)')

  // Navigate to item 2 (rejected QA)
  const nextBtn = await page.locator('button').filter({ hasText: '▶' }).first()
  await nextBtn.click()
  await page.waitForTimeout(400)
  shot = path.join(SCREENSHOTS_DIR, '03-item2-rejected-qa.png')
  await page.screenshot({ path: shot, clip })
  console.log('Shot 3: item 2 (rejected QA badge)')

  // Navigate to item 3 (no QA)
  await nextBtn.click()
  await page.waitForTimeout(400)
  shot = path.join(SCREENSHOTS_DIR, '04-item3-no-qa.png')
  await page.screenshot({ path: shot, clip })
  console.log('Shot 4: item 3 (no QA report)')

  // Navigate back to item 1
  const prevBtn = await page.locator('button').filter({ hasText: '◀' }).first()
  await prevBtn.click()
  await page.waitForTimeout(200)
  await prevBtn.click()
  await page.waitForTimeout(400)

  // Enter reject mode
  const rejectBtn = await page.locator('button').filter({ hasText: 'Reject' }).first()
  await rejectBtn.click()
  await page.waitForTimeout(400)
  shot = path.join(SCREENSHOTS_DIR, '05-reject-mode-input.png')
  await page.screenshot({ path: shot, clip })
  console.log('Shot 5: reject mode with reason input')

  // Type a reason
  await page.keyboard.type('Needs more test coverage')
  await page.waitForTimeout(200)
  shot = path.join(SCREENSHOTS_DIR, '06-reject-reason-typed.png')
  await page.screenshot({ path: shot, clip })
  console.log('Shot 6: reject reason typed')

  // Cancel (press Escape or click ✕)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // Approve item 1
  const approveBtn = await page.locator('button').filter({ hasText: 'Approve' }).first()
  await approveBtn.click()
  await page.waitForTimeout(1500)
  shot = path.join(SCREENSHOTS_DIR, '07-after-approve-2-remain.png')
  await page.screenshot({ path: shot, clip })
  console.log('Shot 7: after approve (2 items remain)')

  // Approve remaining items to reach empty state
  const approve2 = await page.locator('button').filter({ hasText: 'Approve' }).first()
  await approve2.click()
  await page.waitForTimeout(1200)
  const approve3 = await page.locator('button').filter({ hasText: 'Approve' }).first()
  if (await approve3.count() > 0) {
    await approve3.click()
    await page.waitForTimeout(1200)
  }

  // Shot 8: Empty inbox
  shot = path.join(SCREENSHOTS_DIR, '08-empty-inbox.png')
  await page.screenshot({ path: shot, clip })
  console.log('Shot 8: empty inbox state')

  // Copy to output dir
  const shots = [
    '01-initial-full-canvas.png',
    '02-item1-approved-qa.png',
    '03-item2-rejected-qa.png',
    '04-item3-no-qa.png',
    '05-reject-mode-input.png',
    '06-reject-reason-typed.png',
    '07-after-approve-2-remain.png',
    '08-empty-inbox.png',
  ]
  for (const s of shots) {
    const src = path.join(SCREENSHOTS_DIR, s)
    const dst = path.join(REPORT_OUTPUT_DIR, s)
    if (existsSync(src)) {
      await copyFile(src, dst)
      console.log(`Copied ${s}`)
    } else {
      console.warn(`MISSING: ${s}`)
    }
  }

  await browser.close()
  vite.kill()
  console.log('Done.')
}

run().catch(e => { console.error(e); process.exit(1) })
