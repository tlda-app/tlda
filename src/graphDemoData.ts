// Demo content for the native argument-graph: the bias-characterization proof
// (lem:operating-point) from bregman-lower-bound. Spine-primary model —
//   node  = a proof step: a CLAIM plus its JUSTIFICATION prose (real text),
//           or a leaf assumption (a given, no justification).
//   edge  = a bare "depends-on" link; `via` is an optional short lemma tag.
// Content only (non-layout). Math is $…$ (KaTeX).
export type GNode = {
  id: string
  kind: 'assumption' | 'step' | 'goal'
  claim: string
  justification?: string
}
export type GEdge = { id: string; from: string; to: string; via?: string; weight: 'load-bearing' | 'one-liner' }
export type Chain = { sourceLeafIds: string[]; nodes: GNode[]; edges: GEdge[] }

export const biasChain: Chain = {
  sourceLeafIds: [],
  nodes: [
    // assumptions (leaves of the spine)
    { id: 't1', kind: 'assumption', claim: 'Perspective convexity: if $g$ is convex, $(x,t)\\mapsto t\\,g(x/t)$ is jointly convex.' },
    { id: 't2', kind: 'assumption', claim: 'Duality lemma: the modulus is the dual loss for dispersion $u\\chi$ with a linear penalty.' },
    { id: 't3', kind: 'assumption', claim: 'Envelope theorem (Danskin): for $\\omega(u)=\\inf_\\gamma f(\\gamma,u)$ with a unique minimizer, $\\omega$ is differentiable.' },
    { id: 't4', kind: 'assumption', claim: 'KKT + Slater: under Slater’s condition, the constrained minimizer is characterized by a multiplier $\\hat\\lambda\\ge0$.' },

    // steps (claim + justification)
    {
      id: 's1', kind: 'step',
      claim: '$\\omega$ is concave.',
      justification: 'Write $h(f,u)=\\hat P\\{\\dot\\psi_Z(f)-u\\,\\chi^*(f/u)\\}$. The perspective $(f,u)\\mapsto u\\,\\chi^*(f/u)$ is jointly convex, so $h$ is jointly concave; taking the sup over $f\\in B_\\rho$ preserves concavity.',
    },
    {
      id: 's2', kind: 'step',
      claim: '$\\omega(u)=\\inf_\\gamma\\{b(\\gamma)+u\\chi(\\gamma)\\}$, attained at a unique $\\gamma^*(u)$.',
      justification: 'The modulus is exactly the dual loss for dispersion $u\\chi$ and linear penalty, so the duality lemma rewrites it in primal form with a unique minimizer $\\gamma^*(u)$.',
    },
    {
      id: 's3', kind: 'step',
      claim: '$\\omega\'(u)=\\chi(\\gamma^*(u))$.',
      justification: '$\\chi(\\gamma^*(u))$ is a supergradient of $\\omega$ at $u$; by the envelope theorem $\\omega$ is differentiable, so that supergradient must be the derivative.',
    },
    {
      id: 's4', kind: 'step',
      claim: '$b(\\gamma^*(u))=\\omega(u)-u\\,\\omega\'(u)$.',
      justification: 'Substitute $\\omega\'(u)=\\chi(\\gamma^*(u))$ into $\\omega=b(\\gamma^*)+u\\chi(\\gamma^*)$ and solve for $b$. Concavity of $\\omega$ makes this tangent-intercept well-defined.',
    },
    {
      id: 's5', kind: 'step',
      claim: 'A KKT multiplier $\\hat\\lambda\\ge0$ exists (epigraph form).',
      justification: 'Reformulate $\\min_\\gamma \\chi(\\gamma)+\\zeta_\\eta\\{b(\\gamma)\\}$ with an epigraph variable $t\\ge b(\\gamma)$. Slater holds, so KKT gives $\\hat\\lambda\\ge0$ and Lagrangian optimality, line by line.',
    },
    {
      id: 's6', kind: 'step',
      claim: '$\\hat\\lambda\\in\\partial\\zeta_\\eta\\{b(\\hat\\gamma)\\}$.',
      justification: 'The second KKT line makes $\\hat\\lambda$ a subgradient of $\\zeta_\\eta$ at $\\hat t$; since $\\zeta_\\eta$ is strictly increasing, $\\hat\\lambda>0$ and complementary slackness forces $\\hat t=b(\\hat\\gamma)$.',
    },
    {
      id: 's7', kind: 'step',
      claim: '$\\hat\\gamma=\\gamma^*(1/\\hat\\lambda)$.',
      justification: 'The first KKT line makes $\\hat\\gamma$ minimize $\\chi+\\hat\\lambda\\,b$; this matches the unique primal minimizer $\\gamma^*(u)$ at $u=1/\\hat\\lambda$.',
    },
    {
      id: 's8', kind: 'goal',
      claim: 'Bias characterization: $b(\\hat\\gamma)=\\omega(\\hat u)-\\hat u\\,\\omega\'(\\hat u)$, with $\\hat u=1/\\hat\\lambda$.',
      justification: 'Plug the identified operating point $\\hat u=1/\\hat\\lambda$ into the bias formula $b(\\gamma^*(u))=\\omega(u)-u\\,\\omega\'(u)$.',
    },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 's1', via: 'perspective convexity', weight: 'load-bearing' },
    { id: 'e2', from: 't2', to: 's2', via: 'duality', weight: 'one-liner' },
    { id: 'e3', from: 's2', to: 's3', weight: 'one-liner' },
    { id: 'e4', from: 't3', to: 's3', via: 'envelope', weight: 'one-liner' },
    { id: 'e5', from: 's1', to: 's4', weight: 'one-liner' },
    { id: 'e6', from: 's2', to: 's4', weight: 'one-liner' },
    { id: 'e7', from: 's3', to: 's4', weight: 'load-bearing' },
    { id: 'e8', from: 't4', to: 's5', via: 'KKT', weight: 'load-bearing' },
    { id: 'e9', from: 's5', to: 's6', weight: 'one-liner' },
    { id: 'e10', from: 's5', to: 's7', weight: 'one-liner' },
    { id: 'e11', from: 's2', to: 's7', weight: 'one-liner' },
    { id: 'e12', from: 's4', to: 's8', weight: 'load-bearing' },
    { id: 'e13', from: 's6', to: 's8', weight: 'one-liner' },
    { id: 'e14', from: 's7', to: 's8', weight: 'one-liner' },
  ],
}
