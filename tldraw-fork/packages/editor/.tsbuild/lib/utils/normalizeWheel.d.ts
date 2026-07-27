/**
 * Normalizes a wheel event, so that the delta values are consistent across different browsers or devices. Adapted from https://stackoverflow.com/a/13650579.
 * @param event - The wheel event to normalize.
 * @returns The normalized wheel event.
 * @internal */
export declare function normalizeWheel(event: WheelEvent | React.WheelEvent<HTMLElement>): {
    x: number;
    y: number;
    z: number;
};
//# sourceMappingURL=normalizeWheel.d.ts.map