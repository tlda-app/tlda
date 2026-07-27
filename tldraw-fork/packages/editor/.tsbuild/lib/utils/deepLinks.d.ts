import { BoxModel, TLPageId, TLShapeId } from '@tldraw/tlschema';
import type { Editor } from '../editor/Editor';
/** @public */
export type TLDeepLink = {
    type: 'shapes';
    shapeIds: TLShapeId[];
} | {
    type: 'viewport';
    bounds: BoxModel;
    pageId?: TLPageId;
} | {
    type: 'page';
    pageId: TLPageId;
};
/**
 * Converts a deep link descriptor to a url-safe string
 *
 * @example
 * ```ts
 * const url = `https://example.com?d=${createDeepLinkString({ type: 'shapes', shapeIds: ['shape:1', 'shape:2'] })}`
 * navigator.clipboard.writeText(url)
 * ```
 *
 * @param deepLink - the deep link descriptor
 * @returns a url-safe string
 *
 * @public
 */
export declare function createDeepLinkString(deepLink: TLDeepLink): string;
/**
 * Parses a string created by {@link createDeepLinkString} back into a deep link descriptor.
 *
 * @param deepLinkString - the deep link string
 * @returns a deep link descriptor
 *
 * @public
 */
export declare function parseDeepLinkString(deepLinkString: string): TLDeepLink;
/** @public */
export interface TLDeepLinkOptions {
    /**
     * The name of the url search param to use for the deep link.
     *
     * Defaults to `'d'`
     */
    param?: string;
    /**
     * The debounce time in ms for updating the url.
     */
    debounceMs?: number;
    /**
     * Should return the current url to augment with a deep link query parameter.
     * If you supply this function, you must also supply an `onChange` function.
     */
    getUrl?(editor: Editor): string | URL;
    /**
     * Should return the current deep link target.
     * Defaults to returning the current page and viewport position.
     */
    getTarget?(editor: Editor): TLDeepLink;
    /**
     * This is fired when the URL is updated.
     *
     * If not supplied, the default behavior is to update `window.location`.
     *
     * @param url - the updated URL
     */
    onChange?(url: URL, editor: Editor): void;
}
//# sourceMappingURL=deepLinks.d.ts.map