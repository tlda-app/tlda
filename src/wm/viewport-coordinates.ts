import {
  clientPointToPage,
  pagePointToClient,
  pagePointToPage,
} from '../../packages/tldraw-wm/src/viewport-coordinates.ts'

if (typeof window !== 'undefined') {
  ;(window as typeof window & { __tlda_wm_coordinates__?: unknown }).__tlda_wm_coordinates__ = {
    clientPointToPage,
    pagePointToClient,
    pagePointToPage,
  }
}

export * from '../../packages/tldraw-wm/src/viewport-coordinates.ts'
