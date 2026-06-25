/**
 * An object that contains information about the current device and environment.
 * This object is not reactive and will not update automatically when the environment changes,
 * so only include values that are fixed, such as the user's browser and operating system.
 *
 * @public
 */
declare const tlenv: {
    hasCanvasSupport: boolean;
    isAndroid: boolean;
    isChromeForIos: boolean;
    isDarwin: boolean;
    isFirefox: boolean;
    isIos: boolean;
    isSafari: boolean;
    isTouchDevice: boolean;
    isWebview: boolean;
};
/**
 * An atom that contains information about the current device and environment.
 * This object is reactive and will update automatically when the environment changes.
 * Use it for values that may change over time, such as the pointer type.
 *
 * @public
 */
declare const tlenvReactive: import("@tldraw/state").Atom<{
    isCoarsePointer: boolean;
    supportsP3ColorSpace: boolean;
}, unknown>;
export { tlenv, tlenvReactive };
//# sourceMappingURL=environment.d.ts.map