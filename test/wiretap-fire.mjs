#!/usr/bin/env node
// Firing test for the migrated wiretap matcher: a string-expression filter with
// directional to:/from: prefixes must actually CC the tapper on a matching
// (sender, recipient) pair, and must NOT fire otherwise. Exercises the real
// server path: addWiretap (parseFilter validation) -> getWiretaps ->
// _hydrateWiretap (_ast precompute) -> resolveWiretaps (evalExprDirectional).
//
// Run: node test/wiretap-fire.mjs

import { FleetStore } from '../server/lib/fleet-store.mjs'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const TMP = mkdtempSync(path.join(tmpdir(), 'wiretap-fire-'))
const store = new FleetStore(path.join(TMP, 'fleet.db'))

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

const TAP = 'fleet:tap', SND = 'fleet:snd', REC = 'fleet:rec', OTHER = 'fleet:other'

try {
  // directional AND: fires only on a message TO rec FROM snd
  const t1 = store.addWiretap(TAP, 'to:fleet:rec & from:fleet:snd', ['chat'])
  check('addWiretap stored the string filter verbatim', t1.filter === 'to:fleet:rec & from:fleet:snd', `got ${JSON.stringify(t1.filter)}`)

  check('fires on matching to+from', store.resolveWiretaps(SND, REC, 'chat').includes(TAP))
  check('no fire when sender differs', !store.resolveWiretaps(OTHER, REC, 'chat').includes(TAP))
  check('no fire when recipient differs', !store.resolveWiretaps(SND, OTHER, 'chat').includes(TAP))
  check('type filter blocks non-chat event', !store.resolveWiretaps(SND, REC, 'activity').includes(TAP))
  check('tapper is not CC\'d on its own messages', !store.resolveWiretaps(TAP, REC, 'chat').includes(TAP))

  // _ast is precomputed and hidden from serialization
  const listed = store.getWiretapsByAgent(TAP)
  check('listed tap omits internal _ast from enumerable props', listed.length === 1 && !Object.keys(listed[0]).includes('_ast'))
  check('JSON of a listed tap has no _ast', !('_ast' in JSON.parse(JSON.stringify(listed[0]))))

  // bare token = involves either side
  const t2 = store.addWiretap('fleet:tap2', 'fleet:snd', ['chat'])
  check('bare token fires when agent is sender', store.resolveWiretaps(SND, OTHER, 'chat').includes('fleet:tap2'))
  check('bare token fires when agent is recipient', store.resolveWiretaps(OTHER, SND, 'chat').includes('fleet:tap2'))
  check('bare token does not fire when uninvolved', !store.resolveWiretaps(OTHER, REC, 'chat').includes('fleet:tap2'))

  // malformed filter is rejected at add time (parse error)
  let addErr = null
  try { store.addWiretap('fleet:tap3', 'from:snd &', ['chat']) } catch (e) { addErr = e.message }
  check('malformed filter rejected at add', /parse error/.test(addErr || ''), `got ${addErr}`)

  // non-string filter rejected
  let typeErr = null
  try { store.addWiretap('fleet:tap4', [[['from', 'snd']]], ['chat']) } catch (e) { typeErr = e.message }
  check('array (old DNF) filter rejected', /must be a non-empty string/.test(typeErr || ''), `got ${typeErr}`)
} finally {
  try { store.db.close() } catch {}
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
}

console.log(`\n[wiretap-fire] === ${pass} pass / ${fail} fail ===`)
process.exit(fail ? 1 : 0)
