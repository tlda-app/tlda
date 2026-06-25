/**
 * Just a wrapper around `window.fetch` that sets the `referrerPolicy` to `strict-origin-when-cross-origin`.
 *
 * @param input - A Request object or string containing the URL to fetch
 * @param init - Optional request initialization options
 * @returns Promise that resolves to the Response object
 * @internal
 */
export declare function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
/**
 * Just a wrapper around `new Image`, and yeah, it's a bit strange that it's in the network.ts file
 * but the main concern here is the referrerPolicy and setting it correctly.
 *
 * @param width - Optional width for the image element
 * @param height - Optional height for the image element
 * @returns HTMLImageElement with referrerPolicy set to 'strict-origin-when-cross-origin'
 * @internal
 */
export declare function Image(width?: number, height?: number): HTMLImageElement;
//# sourceMappingURL=network.d.ts.map