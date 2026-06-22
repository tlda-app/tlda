/**
 * Export delay is a helper class that allows you to wait for a set of promises to resolve before
 * proceeding with an export. Over time, promises can be added by calling `waitUntil`.
 *
 * When `resolve` is called, we'll wait for all the promises already added (and any new ones added
 * in the mean time) to resolve before proceeding. The class is designed to be used once: after
 * `resolve` has been called and finished, new promises cannot be added.
 */
export declare class ExportDelay {
    private readonly maxDelayTimeMs;
    private isResolved;
    private readonly promisesToWaitFor;
    constructor(maxDelayTimeMs: number);
    waitUntil(promise: Promise<void>): void;
    private resolvePromises;
    resolve(): Promise<void>;
}
//# sourceMappingURL=ExportDelay.d.ts.map