/** @public */
export declare const EASINGS: {
    readonly linear: (t: number) => number;
    readonly easeInQuad: (t: number) => number;
    readonly easeOutQuad: (t: number) => number;
    readonly easeInOutQuad: (t: number) => number;
    readonly easeInCubic: (t: number) => number;
    readonly easeOutCubic: (t: number) => number;
    readonly easeInOutCubic: (t: number) => number;
    readonly easeInQuart: (t: number) => number;
    readonly easeOutQuart: (t: number) => number;
    readonly easeInOutQuart: (t: number) => number;
    readonly easeInQuint: (t: number) => number;
    readonly easeOutQuint: (t: number) => number;
    readonly easeInOutQuint: (t: number) => number;
    readonly easeInSine: (t: number) => number;
    readonly easeOutSine: (t: number) => number;
    readonly easeInOutSine: (t: number) => number;
    readonly easeInExpo: (t: number) => number;
    readonly easeOutExpo: (t: number) => number;
    readonly easeInOutExpo: (t: number) => number;
};
/** @public */
export type EasingType = keyof typeof EASINGS;
//# sourceMappingURL=easings.d.ts.map