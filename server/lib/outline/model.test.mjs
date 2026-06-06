// Smoke tests for seedChainFromLeaf. Run: node model.test.mjs
import { buildModel, seedChainFromLeaf } from './model.mjs'
import { structuralLeaves } from './outline.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++ } else { fail++; console.error(`✗ ${name}`, extra ?? '') } }
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `\n  got: ${JSON.stringify(a)}\n  exp: ${JSON.stringify(b)}`)

// The live line-647 bag-of-properties passage (the failure WRITE-03 is cut from).
const region = `Then $p$ is proper and inherits convexity, lower semicontinuity, strict convexity, and coercivity from $\\chi$, together with $\\zeta \\ge 0$.`
const model = buildModel(region, structuralLeaves(region))

// the leaf we want to split is the one whose body carries the property list
const bagLeaf = model.leaves.find((l) => /coercivity/i.test(l.body))
ok('found bag leaf', !!bagLeaf, model.leaves.map((l) => l.id + ':' + l.body))

const seed = seedChainFromLeaf(model, bagLeaf.id)
eq('sourceLeafIds', seed.sourceLeafIds, [bagLeaf.id])
eq('starts unbound (no nodes)', seed.nodes, [])
eq('starts unbound (no edges)', seed.edges, [])

// the five properties of the bag, in document order, no double-counting
// ("convex" inside "strict convexity" must NOT appear separately)
eq('candidate properties', seed.candidateProperties,
  ['proper', 'convexity', 'lower semicontinuity', 'strict convexity', 'coercivity'])

// unknown leaf id throws
let threw = false
try { seedChainFromLeaf(model, 'lZ') } catch { threw = true }
ok('unknown leaf throws', threw)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
