// Skip, 2026-08-19 04:40 EDT: "we need to have fucking search take an ID ...
// It's like the easiest query in the world ... It's just part of the fucking
// query syntax." And a minute earlier, the design point inside it: "I guess the
// one issue is if search usually returns like a snippet instead of the whole
// thing. Then I guess that's not good."
//
// So there are two claims here and they are different claims:
//   1. `id:<n>` is a TERM in the query language — it parses, it reaches the
//      server, and it selects the one row that id names.
//   2. A row named by id comes back WHOLE. An id is a reference; dereferencing
//      one to a 40-token excerpt is not a dereference.
//
// This exercises the WIRE for (1). The shared parser turns the typed string into
// `filterExpression`, the socket carries it, the server compiles it to SQL and
// evaluates it, and one row comes back. Calling the parser and the evaluator
// from one process would prove both ends and nothing about whether they are
// connected — and an unhandled node type in this compiler degrades to a filter
// that is silently not applied, which is how a query that names one message
// would come back as the whole table.
//
// The control is what makes (2) a measurement rather than an assertion: the SAME
// message is fetched by a text query, and the two answers are compared. If the
// text query already returned the whole thing there would be nothing here to fix.
import WebSocket from 'ws'
import { spawn } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildFleetSearchFilters, parseSearchQuery } from '../shared/fleet-search-query.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PORT = Number(process.env.PORT || (6190 + (process.pid % 900)))
const DB = `/tmp/search-id-term-test-${process.pid}.db`
const ENV_NAME = 'default'
const useTls = existsSync(`${process.env.HOME}/.config/tlda/localhost+2.pem`)
if (useTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const proto = useTls ? 'https' : 'http'
const wsProto = useTls ? 'wss' : 'ws'
const wsOpts = useTls ? { rejectUnauthorized: false } : {}

let srv
let failures = 0
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function cleanup(code) {
  try { srv?.kill('SIGKILL') } catch { /* already gone; nothing to kill */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(`${DB}${suffix}`, { force: true }) } catch { /* temp file, already gone */ }
  }
  process.exit(code)
}
const fail = (m) => { console.error('FAIL:', m); cleanup(1) }
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`) }
  else { failures++; console.error(`  FAIL ${label}${detail ? `: ${detail}` : ''}`) }
}

srv = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TLDA_FLEET_DB: DB, TLDA_DEV_SERVER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
srv.stdout.on('data', d => { serverLog += d })
srv.stderr.on('data', d => { serverLog += d })

async function waitHealth() {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${proto}://localhost:${PORT}/api/health`)
      if (r.ok) return true
    } catch { /* not listening yet — that is what we are waiting for */ }
    await sleep(500)
  }
  return false
}

function openFleet() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsProto}://localhost:${PORT}/ws/fleet`, wsOpts)
    ws.on('open', () => setTimeout(() => resolve(ws), 200))
    ws.on('error', (e) => fail(`fleet WS error: ${e.message}`))
  })
}

let reqSeq = 0
function request(ws, message, timeoutMs = 8000) {
  const id = `search-id-${++reqSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`no reply to "${message.type}" within ${timeoutMs}ms`))
    }, timeoutMs)
    function onMessage(raw) {
      let frame
      try { frame = JSON.parse(raw) } catch { return }
      if (frame.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ ...message, id }))
  })
}

const SENDER = 'fleet:searchid-sender'
const RECIPIENT = 'fleet:searchid-recipient'

// The query string a person actually types, through the parser both surfaces
// share, into the parameters the MCP search tool sends. Nothing is hand-built:
// a test that assembles `filterExpression` itself would pass with the term
// missing from the grammar entirely.
async function searchAs(ws, typed) {
  const parsed = parseSearchQuery(typed, { autoConjoin: false })
  const filters = buildFleetSearchFilters(parsed.filters)
  const reply = await request(ws, {
    type: 'fleet-search',
    query: parsed.query,
    me: SENDER,
    limit: 50,
    filterExpression: filters.filterExpression,
    eventType: filters.eventType,
    role: filters.role,
  })
  if (reply.error) throw new Error(`fleet-search "${typed}" errored: ${reply.error}`)
  return { results: reply.result?.results || [], parsed }
}

async function run() {
  if (!await waitHealth()) fail(`server never became healthy.\n${serverLog}`)
  const ws = await openFleet()

  for (const [agentId, name] of [[SENDER, 'searchidsender'], [RECIPIENT, 'searchidrecipient']]) {
    ws.send(JSON.stringify({ type: 'reserve-shell', agent_id: agentId, name, machine_id: 'testbox', env_name: ENV_NAME }))
    ws.send(JSON.stringify({ type: 'login', agent_id: agentId, machine_id: 'testbox', env_name: ENV_NAME }))
  }
  await sleep(800)

  // Longer than the 120 characters history-mode snippets to and than the 40
  // tokens the FTS snippetter keeps, so "whole" and "excerpt" are visibly
  // different answers rather than the same short string twice. The rare word is
  // what the control query matches on.
  const RARE = 'quillfeather'
  const TEXT = `${RARE} opens this message, and then it keeps going for long enough that no snippetter `
    + 'could return all of it: the first hundred and twenty characters are where history mode cuts, '
    + 'the surrounding forty tokens are where the full-text snippetter cuts, and the point of asking '
    + 'for a message by the id that names it is that neither cut should happen at all. '
    + 'This sentence exists to put the end of the message well past both of those boundaries.'

  const sent = await request(ws, { type: 'chat', from: SENDER, to: RECIPIENT, message: TEXT })
  const messageId = sent.result?.event_ids?.[0]
  if (!messageId) fail(`chat did not return an id to search for. reply: ${JSON.stringify(sent)}`)
  console.log(`  (server assigned id ${messageId})`)
  // A second message, so "selects one row" is a real claim about the filter
  // rather than a fact about an events table with one row in it.
  await request(ws, { type: 'chat', from: SENDER, to: RECIPIENT, message: `${RARE} appears here too, in a different message.` })
  await sleep(400)

  // --- 1. The term reaches the server and selects the row it names. ---
  const byId = await searchAs(ws, `id:${messageId}`)
  check('a typed `id:<n>` becomes a filter term rather than free text',
    byId.parsed.filters.filterExpression === `id:${messageId}` && byId.parsed.query === '',
    `parsed as ${JSON.stringify(byId.parsed.filters.filterExpression)} with query ${JSON.stringify(byId.parsed.query)}`)
  check('and the id it names is reported back as named, so a caller can render it whole',
    JSON.stringify(byId.parsed.filters.messageIds) === JSON.stringify([messageId]),
    `messageIds was ${JSON.stringify(byId.parsed.filters.messageIds)}`)
  check('the query returns exactly the one message that id names',
    byId.results.length === 1 && byId.results[0].id === messageId,
    `got ${byId.results.length} row(s): ${JSON.stringify(byId.results.map(r => r.id))}`)

  // --- 2. It comes back whole, and the control says that is a difference. ---
  check('the row it returns carries the WHOLE message, not a cut of it',
    byId.results[0]?.text === TEXT,
    `text was ${JSON.stringify(byId.results[0]?.text)?.slice(0, 200)}`)
  const byText = await searchAs(ws, RARE)
  const textHit = byText.results.find(r => r.id === messageId)
  check('CONTROL: the same message found by a text query comes back as a snippet',
    !!textHit && typeof textHit.snippet === 'string' && textHit.snippet.length < TEXT.length,
    `snippet was ${JSON.stringify(textHit?.snippet)}`)
  check('CONTROL: and a text query names no id, so nothing else renders whole',
    byText.parsed.filters.messageIds === undefined,
    `messageIds was ${JSON.stringify(byText.parsed.filters.messageIds)}`)

  // --- 3. It is a term in the language, not a parameter beside it. ---
  const composed = await searchAs(ws, `id:${messageId} & from:searchidsender`)
  check('it composes with the rest of the grammar',
    composed.results.length === 1 && composed.results[0].id === messageId,
    `got ${JSON.stringify(composed.results.map(r => r.id))}`)
  const excluded = await searchAs(ws, `id:${messageId} & from:searchidrecipient`)
  check('and composes when the conjunction is false, rather than winning on its own',
    excluded.results.length === 0,
    `got ${JSON.stringify(excluded.results.map(r => r.id))}`)
  const negated = await searchAs(ws, `from:searchidsender & !id:${messageId}`)
  check('a negated id excludes that message and keeps the others',
    negated.results.length > 0 && !negated.results.some(r => r.id === messageId),
    `got ${JSON.stringify(negated.results.map(r => r.id))}`)

  // The canonical `chat#<id>` form the chips print is the same reference wearing
  // presentation syntax, and it says one thing more — so a wrong type matches
  // nothing rather than quietly returning the message anyway.
  const canonical = await searchAs(ws, `id:chat#${messageId}`)
  check('the canonical chat#<id> spelling resolves to the same message',
    canonical.results.length === 1 && canonical.results[0].id === messageId,
    `got ${JSON.stringify(canonical.results.map(r => r.id))}`)
  const wrongType = await searchAs(ws, `id:task_done#${messageId}`)
  check('a canonical form naming the wrong type matches nothing, keeping the type load-bearing',
    wrongType.results.length === 0,
    `got ${JSON.stringify(wrongType.results.map(r => r.id))}`)

  // An id that is not one is a parse error. Answering it as "no results" would
  // be a typo reported as an empty history, which is the failure this whole
  // search surface is built to avoid.
  let rejected = null
  try { await searchAs(ws, 'id:not-a-number') } catch (e) { rejected = e }
  check('a malformed id is a parse error, not an empty result set',
    !!rejected && /not a message id/.test(rejected.message),
    `error was ${JSON.stringify(rejected?.message)}`)

  ws.close()
  console.log(failures === 0
    ? 'PASS search takes a message id as a query term'
    : `FAIL search takes a message id as a query term (${failures})`)
  cleanup(failures === 0 ? 0 : 1)
}

run().catch(e => fail(`${e.message}\n${serverLog.slice(-2000)}`))
