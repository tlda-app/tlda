/** @public */
export declare function loopToHtmlElement(elm: Element): HTMLElement;
/**
 * This function calls `event.preventDefault()` for you. Why is that useful?
 *
 * Because if you enable `window.preventDefaultLogging = true` it'll log out a message when it
 * happens. Because we use console.warn rather than (log) you'll get a stack trace in the inspector
 * telling you exactly where it happened. This is important because `e.preventDefault()` is the
 * source of many bugs, but unfortunately it can't be avoided because it also stops a lot of default
 * behaviour which doesn't make sense in our UI
 *
 * @param event - To prevent default on
 * @public
 */
export declare function preventDefault(event: React.BaseSyntheticEvent | Event): void;
/** @public */
export declare function setPointerCapture(element: Element, event: React.PointerEvent<Element> | PointerEvent): void;
/** @public */
export declare function releasePointerCapture(element: Element, event: React.PointerEvent<Element> | PointerEvent): void;
/**
 * Calls `event.stopPropagation()`.
 *
 * @deprecated Use {@link Editor.markEventAsHandled} instead, or manually call `event.stopPropagation()` if
 * that's what you really want.
 *
 * @public
 */
export declare function stopEventPropagation(e: any): any;
/** @internal */
export declare function setStyleProperty(elm: HTMLElement | null, property: string, value: string | number): void;
/** @internal */
export declare function elementShouldCaptureKeys(el: Element | null, includeButtonsAndMenus?: boolean): boolean;
/**
 * Returns the global `document`. Use this instead of bare `document` to satisfy lint rules.
 *
 * When you have a DOM node or editor instance, prefer the scoped versions instead:
 * - `getOwnerDocument(node)` – the document that owns a specific DOM node
 * - `editor.getContainerDocument()` – the document where the editor is mounted
 *
 * @internal
 */
export declare function getGlobalDocument(): Document;
/**
 * Returns the global `window`. Use this instead of bare `window` to satisfy lint rules.
 *
 * When you have a DOM node or editor instance, prefer the scoped versions instead:
 * - `getOwnerWindow(node)` – the window that owns a specific DOM node
 * - `editor.getContainerWindow()` – the window where the editor is mounted
 *
 * @internal
 */
export declare function getGlobalWindow(): Window & typeof globalThis;
/** @internal */
export declare function activeElementShouldCaptureKeys(includeButtonsAndMenus?: boolean, doc?: Document): boolean;
//# sourceMappingURL=dom.d.ts.map