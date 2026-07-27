import { Atom, Computed } from '@tldraw/state';
import { PerformanceTracker } from '@tldraw/utils';
import type { Editor } from '../Editor';
import { TLCancelEventInfo, TLClickEventInfo, TLCompleteEventInfo, TLEventHandlers, TLEventInfo, TLInterruptEventInfo, TLKeyboardEventInfo, TLPinchEventInfo, TLPointerEventInfo, TLTickEventInfo, TLWheelEventInfo } from '../types/event-types';
/** @public */
export interface TLStateNodeConstructor {
    new (editor: Editor, parent?: StateNode): StateNode;
    id: string;
    initial?: string;
    children?(): TLStateNodeConstructor[];
    isLockable: boolean;
    useCoalescedEvents: boolean;
    trackPerformance: boolean;
}
/** @public */
export declare abstract class StateNode implements Partial<TLEventHandlers> {
    editor: Editor;
    performanceTracker: PerformanceTracker;
    constructor(editor: Editor, parent?: StateNode);
    static id: string;
    static initial?: string;
    static children?: () => TLStateNodeConstructor[];
    static isLockable: boolean;
    static useCoalescedEvents: boolean;
    /** Set to `true` in subclasses to emit interaction-start/end performance events when this state is entered/exited. */
    static trackPerformance: boolean;
    id: string;
    type: 'branch' | 'leaf' | 'root';
    shapeType?: string;
    initial?: string;
    children?: Record<string, StateNode>;
    isLockable: boolean;
    useCoalescedEvents: boolean;
    parent: StateNode;
    /**
     * This node's path of active state nodes
     *
     * @public
     */
    getPath(): string;
    _path: Computed<string>;
    /**
     * This node's current active child node, if any.
     *
     * @public
     */
    getCurrent(): StateNode | undefined;
    private _current;
    /**
     * Whether this node is active.
     *
     * @public
     */
    getIsActive(): boolean;
    private _isActive;
    /**
     * Transition to a new active child state node.
     *
     * @example
     * ```ts
     * parentState.transition('childStateA')
     * parentState.transition('childStateB', { myData: 4 })
     *```
     *
     * @param id - The id of the child state node to transition to.
     * @param info - Any data to pass to the `onEnter` and `onExit` handlers.
     *
     * @public
     */
    transition(id: string, info?: any): this;
    handleEvent(info: Exclude<TLEventInfo, TLPinchEventInfo>): void;
    enter(info: any, from: string): void;
    exit(info: any, to: string): void;
    /**
     * This is a hack / escape hatch that will tell the editor to
     * report a different state as active (in `getCurrentToolId()`) when
     * this state is active. This is usually used when a tool transitions
     * to a child of a different state for a certain interaction and then
     * returns to the original tool when that interaction completes; and
     * where we would want to show the original tool as active in the UI.
     *
     * @public
     */
    _currentToolIdMask: Atom<string | undefined, unknown>;
    getCurrentToolIdMask(): string | undefined;
    setCurrentToolIdMask(id: string | undefined): void;
    /**
     * Add a child node to this state node.
     *
     * @public
     */
    addChild(childConstructor: TLStateNodeConstructor): this;
    onWheel?(info: TLWheelEventInfo): void;
    onPointerDown?(info: TLPointerEventInfo): void;
    onPointerMove?(info: TLPointerEventInfo): void;
    onLongPress?(info: TLPointerEventInfo): void;
    onPointerUp?(info: TLPointerEventInfo): void;
    onDoubleClick?(info: TLClickEventInfo): void;
    onRightClick?(info: TLPointerEventInfo): void;
    onMiddleClick?(info: TLPointerEventInfo): void;
    onKeyDown?(info: TLKeyboardEventInfo): void;
    onKeyUp?(info: TLKeyboardEventInfo): void;
    onKeyRepeat?(info: TLKeyboardEventInfo): void;
    onCancel?(info: TLCancelEventInfo): void;
    onComplete?(info: TLCompleteEventInfo): void;
    onInterrupt?(info: TLInterruptEventInfo): void;
    onTick?(info: TLTickEventInfo): void;
    onEnter?(info: any, from: string): void;
    onExit?(info: any, to: string): void;
}
//# sourceMappingURL=StateNode.d.ts.map