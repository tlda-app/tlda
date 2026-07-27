import { AtomSet } from '@tldraw/store';
import { Vec } from '../../../primitives/Vec';
import type { Editor } from '../../Editor';
import { TLPinchEventInfo, TLPointerEventInfo, TLWheelEventInfo } from '../../types/event-types';
/** @public */
export declare class InputsManager {
    private readonly editor;
    constructor(editor: Editor);
    /** @internal */
    dispose(): void;
    private _onFrame;
    private _originPagePoint;
    /**
     * The most recent pointer down's position in the current page space.
     */
    getOriginPagePoint(): Vec;
    /**
     * @deprecated Use `getOriginPagePoint()` instead.
     */
    get originPagePoint(): Vec;
    private _originScreenPoint;
    /**
     * The most recent pointer down's position in screen space.
     */
    getOriginScreenPoint(): Vec;
    /**
     * @deprecated Use `getOriginScreenPoint()` instead.
     */
    get originScreenPoint(): Vec;
    private _previousPagePoint;
    /**
     * The previous pointer position in the current page space.
     */
    getPreviousPagePoint(): Vec;
    /**
     * @deprecated Use `getPreviousPagePoint()` instead.
     */
    get previousPagePoint(): Vec;
    private _previousScreenPoint;
    /**
     * The previous pointer position in screen space.
     */
    getPreviousScreenPoint(): Vec;
    /**
     * @deprecated Use `getPreviousScreenPoint()` instead.
     */
    get previousScreenPoint(): Vec;
    private _currentPagePoint;
    /**
     * The most recent pointer position in the current page space.
     */
    getCurrentPagePoint(): Vec;
    /**
     * @deprecated Use `getCurrentPagePoint()` instead.
     */
    get currentPagePoint(): Vec;
    private _currentScreenPoint;
    /**
     * The most recent pointer position in screen space.
     */
    getCurrentScreenPoint(): Vec;
    /**
     * @deprecated Use `getCurrentScreenPoint()` instead.
     */
    get currentScreenPoint(): Vec;
    private _pointerVelocity;
    /**
     * Velocity of mouse pointer, in pixels per millisecond.
     */
    getPointerVelocity(): Vec;
    /**
     * @deprecated Use `getPointerVelocity()` instead.
     */
    get pointerVelocity(): Vec;
    /**
     * Normally you shouldn't need to set the pointer velocity directly. Used in tests to fake pointer velocity.
     * @param pointerVelocity - The pointer velocity.
     * @internal
     */
    setPointerVelocity(pointerVelocity: Vec): void;
    /**
     * A set containing the currently pressed keys.
     */
    readonly keys: AtomSet<string>;
    /**
     * A set containing the currently pressed buttons.
     */
    readonly buttons: AtomSet<number>;
    private _isPen;
    /**
     * Whether the input is from a pen.
     */
    getIsPen(): boolean;
    /**
     * @deprecated Use `getIsPen()` instead.
     */
    get isPen(): boolean;
    set isPen(isPen: boolean);
    /**
     * @param isPen - Whether the input is from a pen.
     */
    setIsPen(isPen: boolean): void;
    private _shiftKey;
    /**
     * Whether the shift key is currently pressed.
     */
    getShiftKey(): boolean;
    /**
     * @deprecated Use `getShiftKey()` instead.
     */
    get shiftKey(): boolean;
    set shiftKey(shiftKey: boolean);
    /**
     * @param shiftKey - Whether the shift key is pressed.
     * @internal
     */
    setShiftKey(shiftKey: boolean): void;
    private _metaKey;
    /**
     * Whether the meta key is currently pressed.
     */
    getMetaKey(): boolean;
    /**
     * @deprecated Use `getMetaKey()` instead.
     */
    get metaKey(): boolean;
    set metaKey(metaKey: boolean);
    /**
     * @param metaKey - Whether the meta key is pressed.
     * @internal
     */
    setMetaKey(metaKey: boolean): void;
    private _ctrlKey;
    /**
     * Whether the ctrl or command key is currently pressed.
     */
    getCtrlKey(): boolean;
    /**
     * @deprecated Use `getCtrlKey()` instead.
     */
    get ctrlKey(): boolean;
    set ctrlKey(ctrlKey: boolean);
    /**
     * @param ctrlKey - Whether the ctrl key is pressed.
     * @internal
     */
    setCtrlKey(ctrlKey: boolean): void;
    private _altKey;
    /**
     * Whether the alt or option key is currently pressed.
     */
    getAltKey(): boolean;
    /**
     * @deprecated Use `getAltKey()` instead.
     */
    get altKey(): boolean;
    set altKey(altKey: boolean);
    /**
     * @param altKey - Whether the alt key is pressed.
     * @internal
     */
    setAltKey(altKey: boolean): void;
    /**
     * Is the accelerator key (cmd on mac, ctrl elsewhere) currently pressed.
     */
    getAccelKey(): boolean;
    /**
     * @deprecated Use `getAccelKey()` instead.
     */
    get accelKey(): boolean;
    private _isDragging;
    /**
     * Whether the user is dragging.
     */
    getIsDragging(): boolean;
    /**
     * Soon to be deprecated, use `getIsDragging()` instead.
     */
    get isDragging(): boolean;
    set isDragging(isDragging: boolean);
    /**
     * @param isDragging - Whether the user is dragging.
     */
    setIsDragging(isDragging: boolean): void;
    private _isPointing;
    /**
     * Whether the user is pointing.
     */
    getIsPointing(): boolean;
    /**
     * @deprecated Use `getIsPointing()` instead.
     */
    get isPointing(): boolean;
    set isPointing(isPointing: boolean);
    /**
     * @param isPointing - Whether the user is pointing.
     * @internal
     */
    setIsPointing(isPointing: boolean): void;
    private _isRightPointing;
    /**
     * Whether the user is right-click pointing (before drag threshold).
     */
    getIsRightPointing(): boolean;
    /** @internal */
    setIsRightPointing(isRightPointing: boolean): void;
    private _isPinching;
    /**
     * Whether the user is pinching.
     */
    getIsPinching(): boolean;
    /**
     * @deprecated Use `getIsPinching()` instead.
     */
    get isPinching(): boolean;
    set isPinching(isPinching: boolean);
    /**
     * @param isPinching - Whether the user is pinching.
     * @internal
     */
    setIsPinching(isPinching: boolean): void;
    private _isEditing;
    /**
     * Whether the user is editing.
     */
    getIsEditing(): boolean;
    /**
     * @deprecated Use `getIsEditing()` instead.
     */
    get isEditing(): boolean;
    set isEditing(isEditing: boolean);
    /**
     * @param isEditing - Whether the user is editing.
     */
    setIsEditing(isEditing: boolean): void;
    private _isPanning;
    /**
     * Whether the user is panning.
     */
    getIsPanning(): boolean;
    /**
     * @deprecated Use `getIsPanning()` instead.
     */
    get isPanning(): boolean;
    set isPanning(isPanning: boolean);
    /**
     * @param isPanning - Whether the user is panning.
     * @internal
     */
    setIsPanning(isPanning: boolean): void;
    private _isSpacebarPanning;
    /**
     * Whether the user is spacebar panning.
     */
    getIsSpacebarPanning(): boolean;
    /**
     * @deprecated Use `getIsSpacebarPanning()` instead.
     */
    get isSpacebarPanning(): boolean;
    set isSpacebarPanning(isSpacebarPanning: boolean);
    /**
     * @param isSpacebarPanning - Whether the user is spacebar panning.
     * @internal
     */
    setIsSpacebarPanning(isSpacebarPanning: boolean): void;
    private _getHasCollaborators;
    /**
     * The previous point used for velocity calculation (updated each tick, not each pointer event).
     * @internal
     */
    private _velocityPrevPoint;
    /**
     * Update the pointer velocity based on elapsed time. Called each frame.
     * @param elapsed - The time elapsed since the last tick in milliseconds.
     * @internal
     */
    updatePointerVelocity(elapsed: number): void;
    /**
     * Update the input points from a pointer, pinch, or wheel event.
     *
     * @param info - The event info.
     * @internal
     */
    updateFromEvent(info: TLPinchEventInfo | TLPointerEventInfo | TLWheelEventInfo): void;
    toJson(): {
        altKey: boolean;
        buttons: number[];
        ctrlKey: boolean;
        currentPagePoint: import("@tldraw/tlschema").VecModel;
        currentScreenPoint: import("@tldraw/tlschema").VecModel;
        isDragging: boolean;
        isEditing: boolean;
        isPanning: boolean;
        isPen: boolean;
        isPinching: boolean;
        isPointing: boolean;
        isSpacebarPanning: boolean;
        keys: string[];
        metaKey: boolean;
        originPagePoint: import("@tldraw/tlschema").VecModel;
        originScreenPoint: import("@tldraw/tlschema").VecModel;
        pointerVelocity: import("@tldraw/tlschema").VecModel;
        previousPagePoint: import("@tldraw/tlschema").VecModel;
        previousScreenPoint: import("@tldraw/tlschema").VecModel;
        shiftKey: boolean;
    };
}
//# sourceMappingURL=InputsManager.d.ts.map