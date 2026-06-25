/** @public */
export declare const runtime: {
    openWindow(url: string, target: string, allowReferrer?: boolean): void;
    refreshPage(): void;
    hardReset(): Promise<void>;
};
/** @public */
export declare function setRuntimeOverrides(input: Partial<typeof runtime>): void;
/**
 * Open a new window with the given URL and target. Prefer this to the window.open function, as it
 * will work more reliably in embedded scenarios, such as our VS Code extension. See the runtime
 * object in tldraw/editor for more details.
 *
 * @param url - The URL to open.
 * @param target - The target window to open the URL in.
 * @param allowReferrer - Whether to allow the referrer to be sent to the new window.
 * @returns The new window object.
 * @public
 */
export declare function openWindow(url: string, target?: string, allowReferrer?: boolean): void;
/** @public */
export declare function refreshPage(): void;
/** @public */
export declare function hardResetEditor(): void;
//# sourceMappingURL=runtime.d.ts.map