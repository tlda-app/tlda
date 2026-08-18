#!/usr/bin/env node
// A verb nobody dispatches, and a field nothing carries.
//
// Three times this repository has shipped a feature where one side produced
// something, the other side consumed it, and nothing in between carried it —
// every unit test green, because both ends were called from one process:
//
//   agent-route            announced into a server that had dropped its handler
//                          eleven days earlier
//   adopt-shadow-history   written on both ends, never given a server case, so
//                          linking a project silently lost its version history
//                          for two days
//   refusedRevision        set by the server, read by the daemon, absent from
//                          the params object the transport rebuilds field by
//                          field — the feature would have shipped inert
//
// AGENTS.md §"Prove the wire, not the two ends" already names the first two and
// already says to grep the literal and count the sites. The third shipped
// anyway, written by someone who had read that section, and was pushed by
// someone who has quoted it at three people. A rule that specific, that
// recently paid for, in the file everyone loads, did not stop the third
// occurrence. **More prose is not the remedy.** This runs.
//
// TWO RULES, and each is the shape of a real defect rather than a tidiness
// preference:
//
//   1. A verb that is sent must be dispatched, and one that is dispatched
//      should be sent. One-sided means nobody is listening — agent-route and
//      adopt-shadow-history.
//
//   2. A field the receiving handler destructures out of its frame must appear
//      in the file that sends that verb. This is the refusedRevision shape and
//      it is the one a naive occurrence count MISSES: the literal was in four
//      files — producer, consumer, and two tests — and in none of them was it
//      the transport.
//
// TESTS ARE NOT SITES. A test that calls both ends in one process is exactly
// what made all three invisible, so a verb or field that exists only in tests
// counts as unreached. That is deliberate and it is the whole point.
//
// This is a lower bound. It reads literals, so a verb built by concatenation or
// held in a variable is invisible to it, the same way the websocket boundary
// guard says its own count is a lower bound. It is meant to make the cheap
// manual grep automatic, not to be a type system.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
// Every directory that can hold a send site or a handler. agent-launch was
// missing on the first run and the guard reported 'spawn' as undispatched when
// its handler is agentLauncher.handlers.spawn — a scanner blind spot reads
// exactly like a real finding, so the list is explicit rather than inferred.
const SOURCE_DIRS = ['agent-launch', 'agent-runtime', 'bin', 'cli', 'daemon', 'foundation', 'mcp-server', 'scripts', 'server', 'shared', 'src', 'telemetry']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'scratch'])

// Named so a reader can tell a deliberate exception from an oversight, on the
// websocket-boundary-guard precedent: every entry carries why.
// Empty on purpose. The first draft carried an entry for 'spawn-availability'
// explaining why its handler could not be found — and the handler was there all
// along, three lines from `spawn`, in a file the scanner was not reading. An
// allowlist entry written to explain a finding you have not chased is how a
// guard is taught to lie. Chase it first; if it is genuinely deliberate, say why
// here.
const ALLOWED_VERBS = {}

const ALLOWED_FIELDS = {
  // '<verb>.<field>': 'why the sender legitimately does not name it'
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else if (/\.(mjs|js|ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const isTest = file => /\.test\.|-test\.|\/tests?\//.test(file)

// This file quotes handler signatures in its own comments to explain what it
// looks for, and `bin/` sorts before `daemon/`, so it found its own prose first
// and read the destructure out of a sentence about destructures. That silently
// emptied the field check for mirror-shadow-ref — the verb this guard exists
// for. A scanner must not be in its own corpus.
const SELF = new URL(import.meta.url).pathname

const files = SOURCE_DIRS.flatMap(d => walk(join(ROOT, d)))
const sources = new Map()
for (const file of files) {
  if (file === SELF) continue
  try { sources.set(file, readFileSync(file, 'utf8')) } catch { /* unreadable is not a finding */ }
}

// Read a balanced {...} starting at `open`, so a payload containing nested
// objects is captured whole rather than truncated at the first brace.
function balanced(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open, i + 1) }
  }
  return null
}

// Top-level keys of an object literal. Deliberately shallow: a nested object's
// keys are not fields of this frame.
// Comments are stripped first. A `//` comment inside a payload object contains
// commas, and splitting on those made the key after the comment unparseable —
// which on the first run reported refusedRevision as dropped when the fix that
// carries it was right there. A guard that cries wolf on the case it was built
// for is worse than no guard.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:'"\\])\/\/.*$/, '$1'))
    .join('\n')
}

function splitTopLevel(inner) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (c === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1 }
  }
  parts.push(inner.slice(start))
  return parts
}

// Returns { name, optional } per key. `optional` means the receiver wrote a
// default, which is the difference between "this arrives undefined and the code
// breaks" and "a feature behind it is quietly inert" — two findings that deserve
// different volume.
function topLevelKeys(objectText) {
  const keys = []
  for (const part of splitTopLevel(stripComments(objectText).slice(1, -1))) {
    const trimmed = part.trim()
    if (!trimmed || trimmed.startsWith('...')) continue
    const m = trimmed.match(/^['"]?([A-Za-z_$][\w$]*)['"]?\s*([:=]?)/)
    if (!m) continue
    keys.push({ name: m[1], optional: /[:=]\s*\S/.test(trimmed.slice(m[1].length + (trimmed.startsWith("'") || trimmed.startsWith('"') ? 2 : 0))) && trimmed.includes('=') })
  }
  return keys
}
const keyNames = objectText => topLevelKeys(objectText).map(k => k.name)

// ---- sends ---------------------------------------------------------------
// sendDaemonEphemeral(key, 'verb', { ...fields }) and the durable form.
const sends = new Map() // verb -> [{ file, fields }]
for (const [file, text] of sources) {
  if (isTest(file)) continue
  // The verb literal is what matters; the payload may be an object literal or a
  // variable. Requiring a literal payload missed apply-source-update entirely,
  // whose third argument is `target.command`, and reported it as never sent.
  const re = /send(?:DaemonEphemeral|DaemonDurable)\s*\(\s*[^,()]+,\s*['"]([\w-]+)['"]\s*,\s*/g
  let m
  while ((m = re.exec(text))) {
    const after = text.slice(m.index + m[0].length)
    const literal = after.startsWith('{') ? balanced(text, m.index + m[0].length) : null
    const entry = { file: relative(ROOT, file), fields: literal ? keyNames(literal) : null }
    if (!sends.has(m[1])) sends.set(m[1], [])
    sends.get(m[1]).push(entry)
  }
}

// ---- dispatches ----------------------------------------------------------
// machineRpc.register({ 'verb': handler }) plus handler tables that are spread
// into it. A spread is followed to the module that defines `handlers`.
const RPC_SIDE = /(^|\/)(daemon|agent-launch|agent-runtime|bin)\//
const dispatched = new Map() // verb -> { file, handler }
for (const [file, text] of sources) {
  // `handlers = {` is not a reserved name. src/shapes/dragCoordinator.ts has one
  // holding onMove/onUp, which are pointer callbacks and not RPC verbs; scanning
  // it produced two confident findings about a wire that does not exist there.
  if (isTest(file) || !RPC_SIDE.test(relative(ROOT, file))) continue
  const re = /(?:machineRpc\.register\s*\(\s*|handlers\s*[:=]\s*)(\{)/g
  let m
  while ((m = re.exec(text))) {
    const obj = balanced(text, m.index + m[0].length - 1)
    if (!obj) continue
    const inner = obj.slice(1, -1)
    // Quoted keys, bare keys, and SHORTHAND: agent-launch writes `spawn,` with
    // no colon at all, and requiring `'verb':` reported spawn as undispatched
    // when its handler was three lines of shorthand away.
    // Depth-0 entries only. Scanning the whole block picked up the destructured
    // parameters of inline arrow handlers — child_agent_ids, tool_use_id — and
    // reported them as verbs nobody sends.
    for (const entry of splitTopLevel(stripComments(inner))) {
      const m = entry.trim().match(/^(?:['"]([\w-]+)['"]|([A-Za-z_$][\w$]*))\s*(?::([\s\S]*))?$/)
      if (!m) continue
      const verb = m[1] || m[2]
      const handler = (m[3] || m[2] || '').trim()
      if (!verb || dispatched.has(verb)) continue
      dispatched.set(verb, { file: relative(ROOT, file), handler })
    }
  }
}

// ---- handler fields ------------------------------------------------------
// What does the receiving side destructure out of the frame? Two shapes cover
// this repository: an inline `({ a, b }) => …` at the register site, and a
// named function elsewhere whose first parameter is a destructure.
function handlerFields(handlerExpr) {
  const inline = handlerExpr.match(/^\(?\s*(\{)/)
  if (inline) {
    const obj = balanced(handlerExpr, handlerExpr.indexOf('{'))
    if (obj) return topLevelKeys(obj)
  }
  const name = handlerExpr.replace(/^.*\./, '').replace(/[^\w$].*$/, '')
  if (!name) return null
  for (const [file, text] of sources) {
    if (isTest(file)) continue
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(\\s*(\\{)`)
    const m = re.exec(text)
    if (!m) continue
    const obj = balanced(text, m.index + m[0].length - 1)
    if (obj) return topLevelKeys(obj)
  }
  return null
}

const findings = []
const inert = []
const dualUse = []

for (const [verb, sites] of sends) {
  if (dispatched.has(verb)) continue
  if (ALLOWED_VERBS[verb]) continue
  findings.push(`sent but never dispatched: '${verb}' — sent from ${[...new Set(sites.map(s => s.file))].join(', ')}, no handler registered. Nobody is listening.`)
}

// The reverse direction is deliberately weaker, because a verb can be computed
// — `const operation = pendingAgentId ? 'mint' : 'spawn'` is real code here, and
// a strict rule reported six live verbs as orphaned on the first run. So this
// asks only whether the literal is named ANYWHERE outside its own handler: if
// nothing in the tree mentions it, nobody can be sending it.
for (const [verb, at] of dispatched) {
  if (sends.has(verb) || ALLOWED_VERBS[verb]) continue
  const namedElsewhere = [...sources].some(([file, text]) =>
    !isTest(file) && relative(ROOT, file) !== at.file && text.includes(`'${verb}'`))
  if (namedElsewhere) continue
  findings.push(`dispatched and named nowhere else: '${verb}' — handled in ${at.file} and mentioned in no other source file. Either dead or its sender was lost.`)
}

for (const [verb, sites] of sends) {
  const at = dispatched.get(verb)
  if (!at) continue
  const expects = handlerFields(at.handler)
  if (!expects || expects.length === 0) continue
  // A handler that is ALSO called directly is not an RPC contract. agent-launch's
  // `spawn` is the local spawn function, registered as a verb and called
  // in-process too, so its parameter list describes both callers and the RPC
  // sender legitimately names only some of it. Checking those produced eight
  // confident findings about a function behaving exactly as designed.
  const fn = at.handler.replace(/^.*\./, '').replace(/[^\w$].*$/, '')
  // A DECLARATION is not a call. The first version matched
  // `async function mirrorShadowRef({...})` — the definition — and concluded the
  // handler was dual-use, which silently switched off the field check for the
  // exact verb this guard was built for. Verified by reverting 3cffbbce2 and
  // watching it report nothing.
  const callRe = new RegExp(`(^|[^\\w$.])${fn}\\s*\\(`, 'm')
  const declRe = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`, 'g')
  const calledDirectly = fn && [...sources].some(([file, text]) => {
    if (isTest(file) || relative(ROOT, file) === at.file) return false
    return callRe.test(text.replace(declRe, ''))
  })
  if (calledDirectly) { dualUse.push(`'${verb}' (${fn} is called directly elsewhere)`); continue }
  const readable = sites.filter(s => s.fields)
  if (readable.length === 0) continue // payload is a variable; nothing to compare
  const provided = new Set(readable.flatMap(s => s.fields))
  const senders = [...new Set(readable.map(s => s.file))].join(', ')
  for (const field of expects) {
    if (provided.has(field.name)) continue
    if (ALLOWED_FIELDS[`${verb}.${field.name}`]) continue
    if (field.optional) {
      // Defaulted on the receiver, so nothing crashes — whatever it switches on
      // is simply off. This is the refusedRevision shape EXACTLY:
      // `refusedRevision = null` on the handler, absent from the sender, and a
      // whole feature shipping inert. It FAILS: "the feature does nothing" is
      // the exact class this guard exists for, and it is invisible at runtime
      // precisely because nothing crashes. Today's tree has none, so failing on
      // it costs nothing and catches the next one.
      inert.push(`'${verb}'.${field.name} — ${at.file} takes it with a default, ${senders} never sends it.`)
    } else {
      // No default, so the handler reads undefined where it expects a value.
      findings.push(`arrives undefined: '${verb}' handler in ${at.file} destructures '${field.name}' with no default, and no send site names it (senders: ${senders}).`)
    }
  }
}

console.log('wire-boundary-guard')
console.log(`  verbs sent: ${sends.size}   verbs dispatched: ${dispatched.size}   files read: ${sources.size}`)
console.log('')
if (dualUse.length) {
  console.log(`  Field check skipped for ${dualUse.length} verb(s) whose handler is also called directly:`)
  console.log(`    ${dualUse.join(', ')}`)
  console.log('')
}
if (inert.length) {
  console.log('  Defaulted on the receiver, never sent — inert rather than broken:')
  for (const line of inert) console.log(`    ${line}`)
  console.log('')
}
if (findings.length === 0 && inert.length === 0) {
  console.log('  no one-sided verbs and no unnamed handler fields.')
  console.log('')
  console.log('  Lower bound: verbs built by concatenation or held in a variable are')
  console.log('  invisible here, and tests are deliberately not counted as sites.')
  process.exit(0)
}
for (const finding of findings) console.log(`  ${finding}`)
console.log('')
console.log(`  ${findings.length + inert.length} finding(s). A verb or field that exists on both ends and`)
console.log('  crosses nothing is the failure this guard is for; add an ALLOWED entry')
console.log('  with a reason if one of these is deliberate.')
process.exit(1)
