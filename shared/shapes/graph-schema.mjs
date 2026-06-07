import { T } from '@tldraw/validate'

// Props for the argument-graph shape. Like the outline shape, the graph itself
// (nodes/edges) is NOT stored in props — it lives in <slug>.chain.json and is
// fetched/authored over the chain_open/chain_apply surface. The shape only
// carries the pointer (doc, slug) and its box geometry.
export const graphProps = {
  w: T.number,
  h: T.number,
  doc: T.string,
  slug: T.string,
}
