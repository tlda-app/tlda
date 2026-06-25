import type { Editor } from '../../Editor';
/** @public */
export declare class EdgeScrollManager {
    editor: Editor;
    constructor(editor: Editor);
    private _isEdgeScrolling;
    private _edgeScrollDuration;
    getIsEdgeScrolling(): boolean;
    /**
     * Update the camera position when the mouse is close to the edge of the screen.
     * Run this on every tick when in a state where edge scrolling is enabled.
     *
     * @public
     */
    updateEdgeScrolling(elapsed: number): void;
    /**
     * Helper function to get the scroll proximity factor for a given position.
     * @param position - The mouse position on the axis.
     * @param dimension - The component dimension on the axis.
     * @param isCoarse - Whether the pointer is coarse.
     * @param insetStart - Whether the pointer is inset at the start of the axis.
     * @param insetEnd - Whether the pointer is inset at the end of the axis.
     * @internal
     */
    private getEdgeProximityFactors;
    private getEdgeScroll;
    /**
     * Moves the camera when the mouse is close to the edge of the screen.
     * @public
     */
    private moveCameraWhenCloseToEdge;
}
//# sourceMappingURL=EdgeScrollManager.d.ts.map