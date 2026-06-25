import { TLHandle, TLShape, VecModel } from '@tldraw/tlschema';
import { VecLike } from '../../primitives/Vec';
import { TLOverlay } from '../overlays/OverlayUtil';
import { TLViewportId } from '../viewports/TLViewport';
import { TLSelectionHandle } from './selection-types';
/** @public */
export type UiEventType = 'click' | 'keyboard' | 'pinch' | 'pointer' | 'wheel' | 'zoom';
/** @public */
export type TLPointerEventTarget = {
    handle: TLHandle;
    shape: TLShape;
    target: 'handle';
} | {
    handle?: TLSelectionHandle;
    shape?: undefined;
    target: 'selection';
} | {
    overlay: TLOverlay;
    shape?: undefined;
    target: 'overlay';
} | {
    shape: TLShape;
    target: 'shape';
} | {
    shape?: undefined;
    target: 'canvas';
};
/** @public */
export type TLPointerEventName = 'long_press' | 'middle_click' | 'pointer_down' | 'pointer_move' | 'pointer_up' | 'right_click';
/** @public */
export type TLCLickEventName = 'double_click';
/** @public */
export type TLPinchEventName = 'pinch_end' | 'pinch_start' | 'pinch';
/** @public */
export type TLKeyboardEventName = 'key_down' | 'key_repeat' | 'key_up';
/** @public */
export type TLEventName = 'cancel' | 'complete' | 'interrupt' | 'tick' | 'wheel' | TLCLickEventName | TLKeyboardEventName | TLPinchEventName | TLPointerEventName;
/** @public */
export interface TLBaseEventInfo {
    type: UiEventType;
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    accelKey: boolean;
    viewportId?: TLViewportId;
}
/** @public */
export type TLPointerEventInfo = TLBaseEventInfo & {
    /**
     * Whether this pen event appears to be direct manipulation on the display (e.g. Apple Pencil on
     * an iPad or a Surface Pen on a touchscreen) rather than indirect input from a desktop graphics
     * tablet (e.g. a Wacom Intuos). Only direct-display pens should auto-enable pen mode. Drawing and
     * pressure behavior is driven by `isPen` and applies to all pens regardless of this flag.
     */
    isPenDirect?: boolean;
    button: number;
    isPen: boolean;
    name: TLPointerEventName;
    point: VecLike;
    pointerId: number;
    type: 'pointer';
} & TLPointerEventTarget;
/** @public */
export type TLClickEventInfo = TLBaseEventInfo & {
    button: number;
    name: TLCLickEventName;
    phase: 'down' | 'settle-down' | 'settle-up' | 'up';
    point: VecLike;
    pointerId: number;
    type: 'click';
} & TLPointerEventTarget;
/** @public */
export type TLKeyboardEventInfo = TLBaseEventInfo & {
    code: string;
    key: string;
    name: TLKeyboardEventName;
    type: 'keyboard';
};
/** @public */
export type TLPinchEventInfo = TLBaseEventInfo & {
    delta: VecModel;
    name: TLPinchEventName;
    point: VecModel;
    type: 'pinch';
};
/** @public */
export type TLWheelEventInfo = TLBaseEventInfo & {
    delta: VecModel;
    name: 'wheel';
    point: VecModel;
    type: 'wheel';
};
/** @public */
export interface TLCancelEventInfo {
    type: 'misc';
    name: 'cancel';
}
/** @public */
export interface TLCompleteEventInfo {
    type: 'misc';
    name: 'complete';
}
/** @public */
export interface TLInterruptEventInfo {
    type: 'misc';
    name: 'interrupt';
}
/** @public */
export interface TLTickEventInfo {
    type: 'misc';
    name: 'tick';
    elapsed: number;
}
/** @public */
export type TLEventInfo = TLCancelEventInfo | TLClickEventInfo | TLCompleteEventInfo | TLInterruptEventInfo | TLKeyboardEventInfo | TLPinchEventInfo | TLPointerEventInfo | TLTickEventInfo | TLWheelEventInfo;
/** @public */
export type TLPointerEvent = (info: TLPointerEventInfo) => void;
/** @public */
export type TLClickEvent = (info: TLClickEventInfo) => void;
/** @public */
export type TLKeyboardEvent = (info: TLKeyboardEventInfo) => void;
/** @public */
export type TLPinchEvent = (info: TLPinchEventInfo) => void;
/** @public */
export type TLWheelEvent = (info: TLWheelEventInfo) => void;
/** @public */
export type TLCancelEvent = (info: TLCancelEventInfo) => void;
/** @public */
export type TLCompleteEvent = (info: TLCompleteEventInfo) => void;
/** @public */
export type TLInterruptEvent = (info: TLInterruptEventInfo) => void;
/** @public */
export type TLTickEvent = (info: TLTickEventInfo) => void;
/** @public */
export type UiEvent = TLCancelEvent | TLClickEvent | TLCompleteEvent | TLKeyboardEvent | TLPinchEvent | TLPointerEvent;
/** @public */
export type TLEnterEventHandler = (info: any, from: string) => void;
/** @public */
export type TLExitEventHandler = (info: any, to: string) => void;
/** @public */
export interface TLEventHandlers {
    onPointerDown: TLPointerEvent;
    onPointerMove: TLPointerEvent;
    onLongPress: TLPointerEvent;
    onRightClick: TLPointerEvent;
    onDoubleClick: TLClickEvent;
    onMiddleClick: TLPointerEvent;
    onPointerUp: TLPointerEvent;
    onKeyDown: TLKeyboardEvent;
    onKeyUp: TLKeyboardEvent;
    onKeyRepeat: TLKeyboardEvent;
    onWheel: TLWheelEvent;
    onCancel: TLCancelEvent;
    onComplete: TLCompleteEvent;
    onInterrupt: TLInterruptEvent;
    onTick: TLTickEvent;
}
/** @public */
export declare const EVENT_NAME_MAP: Record<Exclude<TLEventName, TLPinchEventName>, keyof TLEventHandlers>;
//# sourceMappingURL=event-types.d.ts.map