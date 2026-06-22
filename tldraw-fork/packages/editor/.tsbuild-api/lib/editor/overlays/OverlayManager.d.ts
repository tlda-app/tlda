import { Geometry2d } from '../../primitives/geometry/Geometry2d';
import { VecLike } from '../../primitives/Vec';
import type { Editor } from '../Editor';
import { OverlayUtil, TLOverlay } from './OverlayUtil';
/**
 * An active overlay util paired with the overlays it produced for the current
 * editor state. Returned by {@link OverlayManager.getActiveOverlayEntries} so
 * hit-test, render, and debug paths share a single scan per reactive tick.
 *
 * @public
 */
export interface TLOverlayEntry {
    util: OverlayUtil;
    overlays: TLOverlay[];
}
/** @public */
export declare class OverlayManager {
    readonly editor: Editor;
    constructor(editor: Editor);
    /** @internal */
    readonly _overlayUtils: Map<string, OverlayUtil<TLOverlay<Record<string, unknown>>>>;
    /**
     * Register an overlay util instance. Called during editor construction.
     * @internal
     */
    registerUtil(util: OverlayUtil): void;
    dispose(): void;
    /**
     * Get an overlay util by type string, overlay instance, or by passing
     * a util class as a generic parameter for type-safe lookup.
     *
     * @example
     * ```ts
     * const util = editor.overlays.getOverlayUtil('brush')
     * const util = editor.overlays.getOverlayUtil<BrushOverlayUtil>('brush')
     * const util = editor.overlays.getOverlayUtil(myOverlay)
     * ```
     *
     * @public
     */
    getOverlayUtil<T extends OverlayUtil>(type: T extends OverlayUtil<infer O> ? O['type'] : string): T;
    getOverlayUtil<O extends TLOverlay>(overlay: O): OverlayUtil<O>;
    /**
     * Returns all registered overlay utils in paint order (ascending zIndex).
     * Utils with the same zIndex preserve their registration order.
     *
     * @public
     */
    getOverlayUtilsInZOrder(): OverlayUtil[];
    /**
     * Reactive list of active overlay utils paired with the overlays they
     * produced for the current editor state, in paint order (ascending
     * zIndex). Both the hit-test and render paths read from this single
     * cached scan instead of each re-deriving the active set. Active utils
     * are included even when their `getOverlays()` returns an empty array,
     * since `render()` may still draw non-interactive UI (e.g. the selection
     * bounding box during brushing).
     *
     * @public
     */
    getActiveOverlayEntries(): TLOverlayEntry[];
    /**
     * Reactively computed list of all currently active overlays, in paint order.
     * @public
     */
    getCurrentOverlays(): TLOverlay[];
    private _geometryCache;
    /**
     * Get hit-test geometry for an overlay, cached by overlay identity. Lets
     * hit-testing on a pointermove storm skip the per-overlay geometry
     * allocation that {@link OverlayUtil.getGeometry} would otherwise do on
     * every call.
     *
     * @public
     */
    getOverlayGeometry(overlay: TLOverlay): Geometry2d | null;
    /**
     * The currently hovered overlay id.
     * @public
     */
    private _hoveredOverlayId;
    getHoveredOverlayId(): null | string;
    getHoveredOverlay(): null | TLOverlay;
    setHoveredOverlay(id: null | string): void;
    /**
     * Hit test all active overlays at a given page point.
     * Returns the topmost overlay whose geometry contains the point, or null.
     * Utils are walked from highest zIndex to lowest so the overlay painted on
     * top also wins the hit test. Within a util, overlays are walked in
     * array order: the first overlay whose geometry contains the point wins,
     * so utils should place highest-priority overlays first in `getOverlays`.
     * Interactive overlays (those with geometry) are checked; non-interactive are skipped.
     *
     * @param point - Point in page coordinates
     * @param margin - Hit test margin
     * @public
     */
    getOverlayAtPoint(point: VecLike, margin?: number): null | TLOverlay;
}
//# sourceMappingURL=OverlayManager.d.ts.map