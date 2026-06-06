// End-to-end test of the chain_open/chain_apply ROUTE FLOW (the data path the
// REST routes + MCP handlers wrap): seed -> persist -> edit -> apply -> reopen.
// Mirrors loadChain/saveChain/chainResponse in server/routes/projects.mjs.
// Run: node chain-flow.test.mjs
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildModel, seedChainFromLeaf } from './model.mjs'
import { structuralLeaves } from './outline.mjs'
import { parseChainMarkdown, emitChainMarkdown, renderChainArrows, validateChain } from './chain.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++ } else { fail++; console.error(`✗ ${name}`, extra ?? '') } }

const dir = mkdtempSync(join(tmpdir(), 'chain-flow-'))
const chainFile = join(dir, 'demo.chain.json')
const loadChain = () => (existsSync(chainFile) ? JSON.parse(readFileSync(chainFile, 'utf8')) : null)
const saveChain = (c) => writeFileSync(chainFile, JSON.stringify(c), 'utf8')
const chainResponse = (c) => ({
  arrows: renderChainArrows(c), markdown: emitChainMarkdown(c),
  candidateProperties: c.candidateProperties || [], validation: validateChain(c),
})

// --- the outline model the chain is seeded from (line-647 bag) ---
const region = `Then $p$ is proper and inherits convexity, lower semicontinuity, strict convexity, and coercivity from $\\chi$, together with $\\zeta \\ge 0$.`
const model = buildModel(region, structuralLeaves(region))
const bagLeaf = model.leaves.find((l) => /coercivity/i.test(l.body))

// === chain_open with seedFromLeaf (no chain exists yet) ===
let chain = loadChain()
ok('open: no chain initially', chain === null)
chain = seedChainFromLeaf(model, bagLeaf.id)
saveChain(chain)
let resp = chainResponse(chain)
ok('open: candidates surfaced', resp.candidateProperties.includes('coercivity'), resp.candidateProperties)
// empty seeded graph has NO structural errors (vacuously valid) — "did they
// build the chain?" is a rubric/grader concern, not validateChain's job. The
// real "not built yet" signal is: no arrows.
ok('open: empty graph vacuously valid', resp.validation.ok, resp.validation.errors)
ok('open: no arrows yet', !resp.arrows.trim())

// === subject edits: binds properties to arrows (the graded move) ===
const edited = `## chain (source: ${bagLeaf.id})

### nodes
- [r0] roadmap | the minimizing sequence converges
- [n1] object | $(\\gamma_j)$
- [n2] state | bounded
- [n3] state | Cauchy
- [n4] state | converges

### edges
- [e1] n1 -> n2 | coercive | one-liner
- [e2] n2 -> n3 | totally convex | load-bearing
  justify: Total convexity turns the function gap into distance control, so the sequence is Cauchy.
- [e3] n3 -> n4 | complete | one-liner
`

// === chain_apply ===
const prev = loadChain()
chain = parseChainMarkdown(edited)
if (prev?.candidateProperties && !chain.candidateProperties) chain.candidateProperties = prev.candidateProperties
saveChain(chain)
resp = chainResponse(chain)
ok('apply: graph now valid', resp.validation.ok, resp.validation.errors)
ok('apply: arrows render with load-bearing bold', resp.arrows.includes('**totally convex**'), resp.arrows)
ok('apply: roadmap on top', resp.arrows.startsWith('*the minimizing sequence converges*'), resp.arrows)
ok('apply: provenance preserved', JSON.stringify(chain.candidateProperties) === JSON.stringify(prev.candidateProperties))

// === reopen (no seed) returns persisted chain ===
const reopened = loadChain()
ok('reopen: persists', reopened && reopened.edges.length === 3 && reopened.nodes.length === 5)
ok('reopen: round-trips through markdown', JSON.stringify(parseChainMarkdown(emitChainMarkdown(reopened)).edges) === JSON.stringify(reopened.edges))

// === apply an invalid edit (dangling endpoint) — validation flags, still persists ===
const broken = `## chain (source: ${bagLeaf.id})
### nodes
- [n1] object | x
### edges
- [e1] n1 -> nX | foo | one-liner
`
const bchain = parseChainMarkdown(broken)
const bresp = chainResponse(bchain)
ok('apply invalid: validation flags dangling', !bresp.validation.ok && bresp.validation.errors.some((e) => /unknown node/.test(e)), bresp.validation.errors)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
