// Smoke tests for chain.mjs pure functions. Run: node chain.test.mjs
import { parseChainMarkdown, emitChainMarkdown, renderChainArrows, validateChain, flowsByCheck } from './chain.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++ } else { fail++; console.error(`✗ ${name}`, extra ?? '') } }
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `\n  got: ${JSON.stringify(a)}\n  exp: ${JSON.stringify(b)}`)

// The validated duality+SLB chain.
const chain = {
  sourceLeafIds: ['l7'],
  nodes: [
    { id: 'r0', kind: 'roadmap', label: 'show the minimizing sequence converges' },
    { id: 'n1', kind: 'object', label: '$(\\gamma_j)$' },
    { id: 'n2', kind: 'state', label: 'bounded' },
    { id: 'n3', kind: 'state', label: 'Cauchy', gloss: 'the gap controls the distance' },
    { id: 'n4', kind: 'state', label: 'converges' },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2', property: 'coercive', weight: 'one-liner' },
    { id: 'e2', from: 'n2', to: 'n3', property: 'totally convex', weight: 'load-bearing',
      justification: 'Total convexity gives a modulus turning the function gap into distance control, so the sequence is Cauchy.' },
    { id: 'e3', from: 'n3', to: 'n4', property: 'complete', weight: 'one-liner' },
  ],
}

// 1. round-trip: parse(emit(chain)) === chain
const round = parseChainMarkdown(emitChainMarkdown(chain))
eq('roundtrip sourceLeafIds', round.sourceLeafIds, chain.sourceLeafIds)
eq('roundtrip nodes', round.nodes, chain.nodes)
eq('roundtrip edges', round.edges, chain.edges)

// 2. validate: the good chain passes
ok('validate good chain', validateChain(chain).ok, validateChain(chain).errors)

// 3. validate catches dangling edge
const bad = { nodes: [{ id: 'n1', kind: 'object', label: 'x' }], edges: [{ id: 'e1', from: 'n1', to: 'nX', property: 'p', weight: 'one-liner' }] }
ok('validate dangling edge', !validateChain(bad).ok)

// 4. validate catches cycle
const cyc = { nodes: [{ id: 'a', kind: 'state', label: 'a' }, { id: 'b', kind: 'state', label: 'b' }],
  edges: [{ id: 'e1', from: 'a', to: 'b', property: 'p', weight: 'one-liner' }, { id: 'e2', from: 'b', to: 'a', property: 'q', weight: 'one-liner' }] }
ok('validate cycle', !validateChain(cyc).ok)

// 5. validate catches empty property (the "arrow with no driving property")
const noprop = { nodes: [{ id: 'a', kind: 'object', label: 'a' }, { id: 'b', kind: 'state', label: 'b' }],
  edges: [{ id: 'e1', from: 'a', to: 'b', property: '', weight: 'one-liner' }] }
ok('validate empty property', !validateChain(noprop).ok)

// 6. renderChainArrows: motion view, load-bearing bolded, roadmap prefixed
const arrows = renderChainArrows(chain)
ok('render has arrows', arrows.includes('-->'), arrows)
ok('render bolds load-bearing', arrows.includes('**totally convex**'), arrows)
ok('render shows roadmap', arrows.includes('minimizing sequence'), arrows)

// 7. flowsByCheck — a flowing proof passes
const goodProse = `We show the minimizing sequence converges.
Coercivity keeps $(\\gamma_j)$ bounded. Because the function is totally convex, the
shrinking gap forces $(\\gamma_j)$ to be Cauchy — this is the step that does the real
work, since total convexity yields a modulus of distance control that the bound alone
cannot give. Completeness of the space then delivers the limit: the sequence converges.`
const good = flowsByCheck(chain, goodProse)
ok('flows good: coverage', good.checks.find((c) => c.name === 'coverage').pass, good)
ok('flows good: order', good.checks.find((c) => c.name === 'order').pass, good)
ok('flows good: weight', good.checks.find((c) => c.name === 'weight').pass, good)

// 8. flowsByCheck — a re-bagged proof fails coverage or fusion
const baggedProse = `The sequence is coercive, totally convex, complete, bounded and convex. Therefore it converges.`
const bagged = flowsByCheck(chain, baggedProse)
ok('flows bagged fails', !bagged.ok, bagged)

// 9. flowsByCheck — missing a property fails coverage
const missingProse = `Coercivity keeps it bounded, and completeness gives a limit, so it converges.`
const missing = flowsByCheck(chain, missingProse)
ok('flows missing-property fails coverage', !missing.checks.find((c) => c.name === 'coverage').pass, missing)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
