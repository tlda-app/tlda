#!/usr/bin/env node
//
// Decides whether the HUD reachability run actually PASSED, so the shell script
// does not have to defer that to a human reading two files.
//
// Why this exists: `pw center` exits 0 whatever it finds. forward() returns
// playwright-cli's status for a SUCCESSFUL eval, and the eval succeeds whether it
// returns onScreen:true, onScreen:false, or a bail-out string like 'no editor' or
// 'no search shape owned by ...'. So a run in which the panel never moved took
// every step green. A green "ALL STEPS PASSED" is the most expensive output this
// harness can produce: three agents already reached a wrong conclusion on exactly
// this question.
//
//   node scratch/hud-pointer-assert.mjs <before.txt> <after.txt> [region]
//
// Exits 0 only if the panel was OUTSIDE the viewport before and INSIDE after.
// Anything else — including a bail-out string, a malformed artifact, or a panel
// that was already on screen so the run proved nothing — exits non-zero.

import { readFileSync } from 'fs'

const argv = process.argv.slice(2)

if (argv[0] !== '--project' && argv.length < 2) {
  console.error('usage: hud-pointer-assert.mjs <before.txt> <after.txt> [region]')
  console.error('       hud-pointer-assert.mjs --project <expected> <where.txt>')
  process.exit(2)
}

const [beforePath, afterPath, region = 'search'] = argv

/**
 * `pw eval` prints a "### Result" line, then the return value as a JSON string
 * literal, then "### Ran Playwright code". The payload is JSON *inside* a JSON
 * string, so it parses twice.
 *
 * A bail-out ('no editor', 'no fleet identity yet', …) parses once to a plain
 * string and is NOT an object. That is a failure, not something to skip past —
 * it is the exact case that used to read as a pass.
 */
function readEvalResult(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    return { error: `cannot read ${path}: ${e.message}` }
  }

  const marker = raw.indexOf('### Result')
  if (marker === -1) return { error: `${path}: no "### Result" section — the eval did not report` }

  const rest = raw.slice(marker + '### Result'.length)
  const end = rest.indexOf('### ')
  const body = (end === -1 ? rest : rest.slice(0, end)).trim()
  if (!body) return { error: `${path}: empty result` }

  let once
  try {
    once = JSON.parse(body)
  } catch {
    return { error: `${path}: result is not valid JSON` }
  }

  if (typeof once !== 'string') {
    return typeof once === 'object' && once ? { value: once } : { error: `${path}: unexpected result shape` }
  }

  try {
    const twice = JSON.parse(once)
    if (typeof twice !== 'object' || !twice) return { error: `${path}: bailed out with "${once}"` }
    return { value: twice }
  } catch {
    // Parsed once to a plain string: a bail-out message, not a measurement.
    return { error: `${path}: bailed out with "${once}"` }
  }
}

function panelOf(state, path) {
  if (!Array.isArray(state.visibleMine)) return { error: `${path}: no visibleMine array` }
  const hit = state.visibleMine.filter(p => String(p.id).includes(region))
  if (hit.length === 0) {
    return { error: `${path}: no "${region}" panel among ${state.visibleMine.length} visible owned panels` }
  }
  if (hit.length > 1) return { error: `${path}: ${hit.length} panels match "${region}"; expected one` }
  return { panel: hit[0], vp: state.vp }
}

function inside(p, vp) {
  return p.x >= 0 && p.y >= 0 && p.x + p.w <= vp.w && p.y + p.h <= vp.h
}

const fail = m => { console.error(`ASSERTION FAILED: ${m}`); process.exit(1) }

// --project mode. Shares the reader above deliberately: the artifact holds JSON
// inside a JSON string, so a shell grep for `"project":"name"` misses it -- the
// bytes on disk carry the escaped `\"project\":\"name\"`. That mismatch rejected
// a CORRECT project when this check was a grep, which is a gate that fires on the
// good case and therefore gets deleted by the next person it blocks.
if (argv[0] === '--project') {
  const [, expected, wherePath] = argv
  if (!expected || !wherePath) {
    console.error('usage: hud-pointer-assert.mjs --project <expected> <where.txt>')
    process.exit(2)
  }
  const w = readEvalResult(wherePath)
  if (w.error) fail(w.error)
  const actual = w.value.project
  if (actual !== expected) {
    fail(`tab is on project "${actual}", expected "${expected}". Driving a browser writes fleet shapes into whatever room it lands in; refusing rather than littering a project somebody works in.`)
  }
  console.log(`project: ${actual}`)
  process.exit(0)
}

const b = readEvalResult(beforePath)
if (b.error) fail(b.error)
const a = readEvalResult(afterPath)
if (a.error) fail(a.error)

const bp = panelOf(b.value, beforePath)
if (bp.error) fail(bp.error)
const ap = panelOf(a.value, afterPath)
if (ap.error) fail(ap.error)

const wasOutside = !inside(bp.panel, bp.vp)
const nowInside = inside(ap.panel, ap.vp)

const fmt = (p, vp) => `x=${p.x} y=${p.y} ${p.w}x${p.h} in ${vp.w}x${vp.h}`
console.log(`before: ${fmt(bp.panel, bp.vp)}`)
console.log(`after:  ${fmt(ap.panel, ap.vp)}`)

// Already on screen before the fix ran means the run exercised nothing. Green
// here would be a pass that tested nothing, which is the failure being fixed.
if (!wasOutside) {
  fail(`"${region}" was ALREADY inside the viewport before centering — this run proves nothing. Reset the camera and re-run.`)
}
if (!nowInside) {
  fail(`"${region}" is still outside the viewport after centering.`)
}

console.log(`PASS: "${region}" moved from outside to fully inside the viewport.`)
