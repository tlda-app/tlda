/**
 * Re-exports from all stores + clearDocumentStores.
 */

export { subscribeSvgText, getSvgText, hasSvgText, setSvgText, deleteSvgText, clearSvgTextStore } from './svgTextStore'
export { svgViewBoxStore, getSvgViewBox, type SvgViewBox } from './svgViewBoxStore'
export { anchorIndex, setNavigateToAnchor, getNavigateToAnchor, setOnSourceClick, getOnSourceClick, type AnchorEntry } from './anchorIndex'
export {
  changeStore, changedPages, onChangeStoreUpdate, onShapeChangeUpdate,
  setChangeHighlights, dismissPageChanges, dismissAllChanges,
  type ChangeRegion,
} from './changeStore'
export { subscribeSearchFilter, getSearchFilter, setSearchFilter, clearSearchFilter } from './searchFilterStore'

import { clearSvgTextStore } from './svgTextStore'
import { svgViewBoxStore } from './svgViewBoxStore'
import { anchorIndex } from './anchorIndex'
import { changeStore, changedPages } from './changeStore'
import { clearSearchFilter } from './searchFilterStore'

/** Clear all module-level stores — call on document switch to prevent stale data. */
export function clearDocumentStores() {
  clearSvgTextStore()
  svgViewBoxStore.clear()
  anchorIndex.clear()
  changeStore.clear()
  changedPages.clear()
  clearSearchFilter()
}
