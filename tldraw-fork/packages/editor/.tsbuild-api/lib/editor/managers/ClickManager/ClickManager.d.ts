import type { Editor } from '../../Editor';
import { TLClickEventInfo, TLPointerEventInfo } from '../../types/event-types';
/** @public */
export type TLClickState = 'idle' | 'overflow' | 'pendingDouble' | 'pendingOverflow';
/** @public */
export declare class ClickManager {
    editor: Editor;
    constructor(editor: Editor);
    private _clickId;
    private _clickTimeout?;
    private _clickScreenPoint?;
    private _previousScreenPoint?;
    private _isPressingWhilePending;
    _getClickTimeout(state: TLClickState, id?: string): void;
    /**
     * The current click state.
     *
     * @internal
     */
    private _clickState?;
    /**
     * The current click state.
     *
     * @public
     */
    get clickState(): TLClickState | undefined;
    lastPointerInfo: TLPointerEventInfo;
    handlePointerEvent(info: TLPointerEventInfo): TLClickEventInfo | TLPointerEventInfo;
    /**
     * Cancel the double click timeout.
     *
     * @internal
     */
    cancelDoubleClickTimeout(): void;
}
//# sourceMappingURL=ClickManager.d.ts.map