declare module 'y-codemirror.next' {
  import type { Extension } from '@codemirror/state'
  import type * as Y from 'yjs'

  export function yCollab(
    ytext: Y.Text,
    awareness?: any,
    options?: { undoManager?: Y.UndoManager | false },
  ): Extension
}
