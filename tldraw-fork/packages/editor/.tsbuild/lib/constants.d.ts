import { TLCameraOptions } from './editor/types/misc-types';
/** @internal */
export declare const DEFAULT_CAMERA_OPTIONS: TLCameraOptions;
/** @internal */
export declare const DEFAULT_ANIMATION_OPTIONS: {
    duration: number;
    easing: (t: number) => number;
};
/**
 * Negative pointer ids are reserved for internal use.
 *
 * @internal */
export declare const INTERNAL_POINTER_IDS: {
    readonly CAMERA_MOVE: -10;
};
/** @public */
export declare const SIDES: readonly ["top", "right", "bottom", "left"];
export declare const LEFT_MOUSE_BUTTON = 0;
export declare const RIGHT_MOUSE_BUTTON = 2;
export declare const MIDDLE_MOUSE_BUTTON = 1;
export declare const STYLUS_ERASER_BUTTON = 5;
//# sourceMappingURL=constants.d.ts.map