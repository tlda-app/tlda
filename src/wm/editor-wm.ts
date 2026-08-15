import { setEditorWMDiagnosticsSink } from '../../packages/tldraw-wm/src/editor-wm.ts'

setEditorWMDiagnosticsSink((diagnostics) => {
  if (typeof window === 'undefined') return
  const target = window as typeof window & {
    __tlda_wm_core__?: unknown
    __tlda_wm_coordinate_traces__?: unknown
  }
  target.__tlda_wm_core__ = {
    id: diagnostics.id,
    wm: diagnostics.wm,
    layerModel: diagnostics.layerModel,
    viewportIds: diagnostics.viewportIds,
    viewports: diagnostics.viewports,
    layerCount: diagnostics.wm.layerCount(),
    layerIds: diagnostics.wm.layerIds(),
    layerIdOfShape: diagnostics.layerIdOfShape,
    shapeLayerReport: diagnostics.shapeLayerReport,
  }
  target.__tlda_wm_coordinate_traces__ = diagnostics.coordinateTraces
})

export * from '../../packages/tldraw-wm/src/editor-wm.ts'
