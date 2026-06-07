import { T } from '@tldraw/validate'

// Props for the argument-graph claim node (one claim on the skeleton). The graph
// structure lives in native bound arrows + the chain content; the node carries
// only its claim text + role. Mirror this exactly on the client shape util.
export const graphNodeProps = {
  w: T.number,
  h: T.number,
  claim: T.string,
  kind: T.string, // 'assumption' | 'step' | 'goal'
}
