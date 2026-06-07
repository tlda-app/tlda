// Demo content for the native argument-graph prototype: the bias-characterization
// proof (lem:operating-point) from bregman-lower-bound.tex, encoded as a chain.
// Content only (non-layout) — positions are computed/native, not stored here.
export type GNode = { id: string; kind: 'object' | 'state' | 'roadmap'; label: string; gloss?: string }
export type GEdge = { id: string; from: string; to: string; property: string; weight: 'load-bearing' | 'one-liner'; justification?: string }
export type GGroup = { id: string; label: string; nodeIds: string[]; parent?: string }
export type Chain = { sourceLeafIds: string[]; nodes: GNode[]; edges: GEdge[]; groups: GGroup[] }

export const biasChain: Chain = {
  sourceLeafIds: [],
  nodes: [
    { id: 'r0', kind: 'roadmap', label: 'Bias characterization: $b(\\hat\\gamma) = \\omega(\\hat u) - \\hat u\\,\\omega\'(\\hat u)$', gloss: 'Maximal bias = y-intercept of the tangent to the modulus at the operating point.' },

    { id: 't1', kind: 'object', label: 'Perspective convexity', gloss: '$(x,t)\\mapsto t\\,g(x/t)$ jointly convex (Boyd 3.2.6).' },
    { id: 't2', kind: 'object', label: 'Duality lemma', gloss: 'Dual loss for dispersion $u\\chi$, linear penalty.' },
    { id: 't3', kind: 'object', label: 'Envelope theorem', gloss: 'Danskin: $\\omega\'(u)=\\partial_u f(\\gamma^*(u),u)$.' },
    { id: 't4', kind: 'object', label: 'KKT + Slater', gloss: 'Multiplier $\\hat\\lambda\\ge0$, complementary slackness.' },

    { id: 's1', kind: 'state', label: '$\\omega$ is concave' },
    { id: 's2', kind: 'state', label: '$\\omega(u) = \\inf_\\gamma\\{b(\\gamma) + u\\chi(\\gamma)\\}$,\\\nunique $\\gamma^*(u)$' },
    { id: 's3', kind: 'state', label: '$\\omega\'(u) = \\chi(\\gamma^*(u))$' },
    { id: 's4', kind: 'state', label: '$b(\\gamma^*(u)) = \\omega(u) - u\\,\\omega\'(u)$' },
    { id: 's5', kind: 'state', label: 'KKT multiplier $\\hat\\lambda \\ge 0$' },
    { id: 's6', kind: 'state', label: '$\\hat\\lambda \\in \\partial\\zeta_\\eta\\{b(\\hat\\gamma)\\}$' },
    { id: 's7', kind: 'state', label: '$\\hat\\gamma = \\gamma^*(1/\\hat\\lambda)$' },
    { id: 's8', kind: 'state', label: '$\\hat u = 1/\\hat\\lambda$:\\\n$b(\\hat\\gamma) = \\omega(\\hat u) - \\hat u\\,\\omega\'(\\hat u)$' },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 's1', property: 'perspective convexity', weight: 'load-bearing' },
    { id: 'e2', from: 't2', to: 's2', property: 'duality lemma', weight: 'one-liner' },
    { id: 'e3', from: 's2', to: 's3', property: 'unique γ*', weight: 'one-liner' },
    { id: 'e4', from: 't3', to: 's3', property: 'envelope theorem', weight: 'one-liner' },
    { id: 'e5', from: 's1', to: 's4', property: 'tangent well-defined', weight: 'one-liner' },
    { id: 'e6', from: 's2', to: 's4', property: 'modulus identity', weight: 'one-liner' },
    { id: 'e7', from: 's3', to: 's4', property: 'substitute ω′', weight: 'load-bearing' },
    { id: 'e8', from: 't4', to: 's5', property: 'KKT + Slater', weight: 'load-bearing' },
    { id: 'e9', from: 's5', to: 's6', property: 'line 2 = subgradient', weight: 'one-liner' },
    { id: 'e10', from: 's5', to: 's7', property: 'line 1 = minimizer', weight: 'one-liner' },
    { id: 'e11', from: 's2', to: 's7', property: 'uniqueness', weight: 'one-liner' },
    { id: 'e12', from: 's4', to: 's8', property: 'evaluate at û', weight: 'load-bearing' },
    { id: 'e13', from: 's6', to: 's8', property: 'û = 1/λ̂', weight: 'one-liner' },
    { id: 'e14', from: 's7', to: 's8', property: 'γ̂ = γ*(û)', weight: 'one-liner' },
  ],
  groups: [
    { id: 'g1', label: '1 · Concavity', nodeIds: ['s1'] },
    { id: 'g2', label: '2 · Primal form', nodeIds: ['s2'] },
    { id: 'g3', label: '3 · Bias formula', nodeIds: ['s3', 's4'] },
    { id: 'g4', label: '4 · Identification', nodeIds: ['s5', 's6', 's7'] },
    { id: 'g4a', label: 'sub-steps', nodeIds: ['s6', 's7'], parent: 'g4' },
  ],
}
