// Headless render verification for the amend V{n} stepper + per-version chip.
// Replicates FleetChatShape's exact fold computation (versions / viewIdx /
// stepper HTML / per-version source) and renders each version state via the
// REAL renderChatLine + REAL fleet-chat.css. Asserts V{n} labels, arrow
// disabled-at-bounds, and that the file-section chip tracks the viewed version.
import { renderChatLine } from '../src/fleet/chat-render.mjs'
import { chromium } from 'playwright'
import fs from 'fs'

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const ctx = {
  agentLabel: id => (id || '').replace('fleet:', ''), getNickClass: () => 'nick-blue',
  isHumanId: id => id === 'fleet:skip', getAgents: () => [], getTasks: () => [],
  tldaToken: null, renderMarkdown: s => s.replace(/\n/g, '<br>'), thinkingAgents: new Map(),
}
const base = { from: 'fleet:agent', to: 'fleet:skip', timestamp: new Date('2026-06-05T10:00:00Z').toISOString(), _dbId: 7 }

// original (source A) + amend1 (source B) + amend2 (no source) — exactly what the
// reference-event server produces, grouped by metadata.amends on the client.
const srcA = { file: '/work/scratch/plan.md', section: 'v1-plan' }
const srcB = { file: '/work/scratch/plan.md', section: 'v2-plan' }
const m = { ...base, text: 'version one', metadata: { source: srcA } }
const amends = [
  { _dbId: 8, text: 'version two from file', metadata: { amends: 7, source: srcB } },
  { _dbId: 9, text: 'version three plain', metadata: { amends: 7 } },
]

// ——— replicate FleetChatShape fold for a given viewIdx ———
function foldRender(viewIdx) {
  const versions = [
    { text: m.text, source: m.metadata?.source ?? null },
    ...amends.map(a => ({ text: a.text, source: a.metadata?.source ?? null })),
  ]
  const total = versions.length
  const vi = Math.min(viewIdx ?? (total - 1), total - 1)
  const backDis = vi <= 0 ? ' disabled' : ''
  const fwdDis = vi >= total - 1 ? ' disabled' : ''
  const oid = esc(String(m._dbId))
  const stepper = `<span class="amend-versions" data-orig="${oid}"><button class="amend-arrow"${backDis} data-orig="${oid}" data-total="${total}" data-dir="back" title="older version">◀</button><span class="amend-vlabel">V${vi + 1}</span><button class="amend-arrow"${fwdDis} data-orig="${oid}" data-total="${total}" data-dir="fwd" title="newer version">▶</button></span>`
  const v = versions[vi]
  const renderM = { ...m, text: v.text, metadata: { ...(m.metadata || {}), source: v.source }, _amendStepper: stepper }
  return renderChatLine(renderM, ctx)
}

let failed = false
const T = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) failed = true }
const h0 = foldRender(0), h1 = foldRender(1), h2 = foldRender(2)
T('V1 shows original text + chip A (§v1-plan), ◀ disabled', h0.includes('version one') && h0.includes('§v1-plan') && /amend-arrow" disabled[^>]*data-dir="back"/.test(h0) && h0.includes('>V1<'))
T('V2 shows amend1 text + chip B (§v2-plan), both arrows enabled', h1.includes('version two') && h1.includes('§v2-plan') && !/disabled[^>]*data-dir/.test(h1) && h1.includes('>V2<'))
T('V3 (latest) shows amend2 text, NO chip, ▶ disabled', h2.includes('version three') && !h2.includes('src-chip') && /amend-arrow" disabled[^>]*data-dir="fwd"/.test(h2) && h2.includes('>V3<'))

// visual flip-book
const css = fs.readFileSync(new URL('../src/shapes/fleet-chat.css', import.meta.url), 'utf8')
const states = [['V1 — original (chip A, ◀ disabled)', h0], ['V2 — amend1 (chip B)', h1], ['V3 — amend2 latest (no chip, ▶ disabled)', h2]]
const body = states.map(([l, h]) => `<div class="state"><div class="lbl">${l}</div><div class="fleet-chat-shape" style="--accent:#9370db">${h}</div></div>`).join('\n')
fs.writeFileSync('/tmp/stepper-render.html', `<!doctype html><meta charset=utf8><style>${css}
body{background:#1b1d23;color:#d8dae0;font-family:system-ui;padding:24px}.state{margin-bottom:22px}.lbl{font-size:12px;color:#8a8f9c;margin-bottom:6px}.fleet-chat-shape{background:#22252c;border:1px solid #2c3038;border-radius:8px;padding:10px 12px;max-width:560px}.fleet-chat-shape .chat-line{font-size:13px;line-height:1.5}</style><h3 style="color:#c0c4cc">Amend V{n} stepper — real renderChatLine + real CSS</h3>${body}`)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 640, height: 600 } })
await page.goto('file:///tmp/stepper-render.html'); await page.screenshot({ path: '/tmp/stepper-render.png', fullPage: true })
await browser.close()
console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL STEPPER-RENDER CHECKS PASSED', '\nshot: /tmp/stepper-render.png')
process.exit(failed ? 1 : 0)
