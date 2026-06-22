import { Driver } from '@tldraw/driver';
import { BoxModel, Editor, IdOf, RequiredKeys, TLContent, TLEditorOptions, TLShape, TLShapePartial, TLStoreOptions } from '@tldraw/editor';
import { BrushOverlayUtil } from '../lib/overlays/BrushOverlayUtil';
import { SelectionForegroundOverlayUtil } from '../lib/overlays/SelectionForegroundOverlayUtil';
import { SnapIndicatorOverlayUtil } from '../lib/overlays/SnapIndicatorOverlayUtil';
import { ZoomBrushOverlayUtil } from '../lib/overlays/ZoomBrushOverlayUtil';
/**
 * Curated set of overlay utils for tests that need canvas hit-testing of
 * resize/rotate/crop handles. Excludes ArrowHint, ShapeHandle, and scribble
 * overlays which can cause circular imports or noisy reactivity in tests.
 *
 * @internal
 */
export declare const defaultHandleOverlays: (typeof BrushOverlayUtil | typeof ZoomBrushOverlayUtil | typeof SelectionForegroundOverlayUtil | typeof SnapIndicatorOverlayUtil)[];
declare module 'vitest' {
    interface Matchers<T = any> {
        toCloselyMatchObject(expected: any, roundToNearest?: number): void;
    }
}
/** @
 * TestEditor is a subclass of Editor that is used to test the editor.
 * @param options - The options for the editor.
 * @param storeOptions - The options for the store.
 * @returns A new TestEditor instance.
 * internal */
export declare class TestEditor extends Editor {
    controller: Driver;
    constructor(options?: Partial<Omit<TLEditorOptions, 'store'>>, storeOptions?: Partial<TLStoreOptions>);
    getHistory(): import("@tldraw/editor").HistoryManager<import("@tldraw/tlschema").TLRecord>;
    elm: HTMLElement;
    readonly bounds: {
        x: number;
        y: number;
        top: number;
        left: number;
        width: number;
        height: number;
        bottom: number;
        right: number;
    };
    setScreenBounds(bounds: BoxModel, center?: boolean): this;
    /**
     * If you need to trigger a double click, you can either mock the implementation of one of these
     * methods, or call mockRestore() to restore the actual implementation (e.g.
     * _transformPointerDownSpy.mockRestore())
     */
    _transformPointerDownSpy: import("vitest").Mock<(info: import("@tldraw/editor").TLPointerEventInfo) => import("@tldraw/editor").TLClickEventInfo | import("@tldraw/editor").TLPointerEventInfo>;
    _transformPointerUpSpy: import("vitest").Mock<(info: import("@tldraw/editor").TLPointerEventInfo) => import("@tldraw/editor").TLClickEventInfo | import("@tldraw/editor").TLPointerEventInfo>;
    getClipboard(): TLContent | null;
    setClipboard(value: TLContent | null): void;
    getLastCreatedShapes(...args: Parameters<Driver['getLastCreatedShapes']>): TLShape[];
    getLastCreatedShape<T extends TLShape>(): T;
    testShapeID(...args: Parameters<Driver['createShapeID']>): import("@tldraw/tlschema").TLShapeId;
    testPageID(...args: Parameters<Driver['createPageID']>): import("@tldraw/tlschema").TLPageId;
    copy(...args: Parameters<Driver['copy']>): this;
    cut(...args: Parameters<Driver['cut']>): this;
    paste(...args: Parameters<Driver['paste']>): this;
    getViewportPageCenter(): import("@tldraw/editor").Vec;
    getSelectionPageCenter(): import("@tldraw/editor").Vec | null;
    getPageCenter(...args: Parameters<Driver['getPageCenter']>): import("@tldraw/editor").Vec | null;
    getPageRotationById(...args: Parameters<Driver['getPageRotationById']>): number;
    getPageRotation(...args: Parameters<Driver['getPageRotation']>): number;
    getArrowsBoundTo(...args: Parameters<Driver['getArrowsBoundTo']>): import("@tldraw/tlschema").TLArrowShape[];
    forceTick(...args: Parameters<Driver['forceTick']>): this;
    pointerMove(...args: Parameters<Driver['pointerMove']>): this;
    pointerDown(...args: Parameters<Driver['pointerDown']>): this;
    pointerUp(...args: Parameters<Driver['pointerUp']>): this;
    click(...args: Parameters<Driver['click']>): this;
    rightClick(...args: Parameters<Driver['rightClick']>): this;
    doubleClick(...args: Parameters<Driver['doubleClick']>): this;
    keyPress(...args: Parameters<Driver['keyPress']>): this;
    keyDown(...args: Parameters<Driver['keyDown']>): this;
    keyRepeat(...args: Parameters<Driver['keyRepeat']>): this;
    keyUp(...args: Parameters<Driver['keyUp']>): this;
    wheel(...args: Parameters<Driver['wheel']>): this;
    pan(...args: Parameters<Driver['pan']>): this;
    pinchStart(...args: Parameters<Driver['pinchStart']>): this;
    pinchTo(...args: Parameters<Driver['pinchTo']>): this;
    pinchEnd(...args: Parameters<Driver['pinchEnd']>): this;
    rotateSelection(...args: Parameters<Driver['rotateSelection']>): this;
    translateSelection(...args: Parameters<Driver['translateSelection']>): this;
    resizeSelection(...args: Parameters<Driver['resizeSelection']>): this;
    createShapesFromJsx(shapesJsx: React.JSX.Element | React.JSX.Element[]): Record<string, import("@tldraw/tlschema").TLShapeId> & {
        bindings: Record<string, import("@tldraw/tlschema").TLBindingId>;
    };
    /**
     * Move to a named selection handle and pointerDown there. The chained equivalent of
     * `pointerDown(x, y, { target: 'selection', handle })` but using a real canvas event
     * that exercises the overlay hit-test path. Requires `defaultHandleOverlays`.
     */
    pointerDownOnHandle(handle: string, modifiers?: Partial<{
        ctrlKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
    }>): this;
    /**
     * Move the pointer by the given delta from its current page position.
     */
    pointerMoveBy(dx: number, dy: number, modifiers?: Partial<{
        ctrlKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
    }>): this;
    /**
     * Get the page point of a named selection handle (resize, rotate, crop, etc.)
     * by querying the SelectionForegroundOverlayUtil. Returns a point that hit-tests
     * to the requested overlay first (some handles overlap, e.g. rotate handles can
     * extend into the resize square area for small selections). Requires
     * `defaultHandleOverlays`.
     */
    getSelectionHandlePagePoint(handle: string): {
        x: number;
        y: number;
    };
    expectToBeIn(path: string): this;
    expectCameraToBe(x: number, y: number, z: number): this;
    expectShapeToMatch<T extends TLShape = TLShape>(...model: RequiredKeys<Partial<TLShapePartial<T>>, 'id'>[]): this;
    expectPageBoundsToBe<T extends TLShape = TLShape>(id: IdOf<T>, bounds: Partial<BoxModel>): this;
    expectScreenBoundsToBe<T extends TLShape = TLShape>(id: IdOf<T>, bounds: Partial<BoxModel>): this;
}
export declare const defaultShapesIds: {
    box1: import("@tldraw/tlschema").TLShapeId;
    box2: import("@tldraw/tlschema").TLShapeId;
    ellipse1: import("@tldraw/tlschema").TLShapeId;
};
export declare function createDefaultShapes(): TLShapePartial[];
//# sourceMappingURL=TestEditor.d.ts.map