import { Atom } from '@tldraw/state';
/** @internal */
export declare const featureFlags: Record<string, DebugFlag<boolean>>;
/** @internal */
export declare const pointerCaptureTrackingObject: DebugFlag<Map<Element, number>>;
/** @internal */
export declare const debugFlags: {
    readonly logPreventDefaults: DebugFlag<boolean>;
    readonly logPointerCaptures: DebugFlag<boolean>;
    readonly logElementRemoves: DebugFlag<boolean>;
    readonly debugSvg: DebugFlag<boolean>;
    readonly showFps: DebugFlag<boolean>;
    readonly measurePerformance: DebugFlag<boolean>;
    readonly throwToBlob: DebugFlag<boolean>;
    readonly reconnectOnPing: DebugFlag<boolean>;
    readonly debugCursors: DebugFlag<boolean>;
    readonly forceSrgb: DebugFlag<boolean>;
    readonly debugGeometry: DebugFlag<boolean>;
    readonly hideShapes: DebugFlag<boolean>;
    readonly editOnType: DebugFlag<boolean>;
    readonly a11y: DebugFlag<boolean>;
    readonly debugElbowArrows: DebugFlag<boolean>;
};
/** @public */
export declare function createDebugValue<T>(name: string, { defaults, shouldStoreForSession }: {
    defaults: DebugFlagDefaults<T>;
    shouldStoreForSession?: boolean;
}): DebugFlag<T>;
/** @public */
export interface DebugFlagDefaults<T> {
    development?: T;
    staging?: T;
    production?: T;
    all: T;
}
/** @public */
export interface DebugFlagDef<T> {
    name: string;
    defaults: DebugFlagDefaults<T>;
    shouldStoreForSession: boolean;
}
/** @public */
export interface DebugFlag<T> extends DebugFlagDef<T>, Atom<T> {
    reset(): void;
}
//# sourceMappingURL=debug-flags.d.ts.map