import { Box, Editor, Vec } from '@tldraw/editor';
export declare class MinimapManager {
    editor: Editor;
    readonly elem: HTMLCanvasElement;
    readonly container: HTMLElement;
    disposables: (() => void)[];
    close(): void;
    private readonly ctx;
    private readonly shapeRectCache;
    constructor(editor: Editor, elem: HTMLCanvasElement, container: HTMLElement);
    private _getColors;
    private colors;
    updateColors(): void;
    readonly id: string;
    getDpr(): number;
    getContentPageBounds(): Box;
    getContentScreenBounds(): Box;
    private _getCanvasBoundingRect;
    private readonly canvasBoundingClientRect;
    getCanvasScreenBounds(): Box;
    private _listenForCanvasResize;
    getCanvasSize(): Vec;
    getCanvasClientPosition(): Vec;
    originPagePoint: Vec;
    originPageCenter: Vec;
    isInViewport: boolean;
    /** Get the canvas's true bounds converted to page bounds. */
    getCanvasPageBounds(): Box;
    /** Minimap screen-pixels per page-unit — same convention as `editor.getCamera().z`. */
    getZoom(): number;
    getMinimapPagePoint(clientX: number, clientY: number): Vec;
    minimapScreenPointToPagePoint(x: number, y: number, shiftKey?: boolean, clampToBounds?: boolean): Vec;
    render(): void;
}
//# sourceMappingURL=MinimapManager.d.ts.map