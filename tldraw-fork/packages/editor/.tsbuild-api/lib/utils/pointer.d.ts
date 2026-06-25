import type React from 'react';
/**
 * Decide whether a pen pointer event looks like direct manipulation on the display (e.g. Apple
 * Pencil on an iPad or a Surface Pen on a touchscreen) rather than indirect input from a desktop
 * graphics tablet (e.g. a Wacom Intuos).
 *
 * We can't tell the two apart from the pointer event itself: both report `pointerType: 'pen'`, and
 * implicit pointer capture — which in theory distinguishes direct-manipulation pointers — isn't
 * reliably observable across browsers (notably WebKit/iPad). Instead we key off the device: a
 * direct-display pen draws on a touch-capable screen, while an indirect graphics tablet is used on
 * a non-touch desktop alongside a mouse. A device with no touch input therefore can't host a
 * direct-display pen.
 *
 * Note this uses {@link tlenv.isTouchDevice} — the device's fixed touch capability — not the
 * editor's dynamic `isCoarsePointer` state, which a pen `pointerdown` flips to coarse regardless
 * of device.
 *
 * @internal
 */
export declare function isDirectDisplayPen(e: PointerEvent | React.PointerEvent): boolean;
/** @internal */
interface PointerLike {
    button: number;
    ctrlKey: boolean;
    metaKey: boolean;
}
/** @internal */
export declare function isSecondaryClickEvent(e: PointerLike): boolean;
/** @internal */
export declare function getPointerEventButton(e: PointerLike): number;
export {};
//# sourceMappingURL=pointer.d.ts.map