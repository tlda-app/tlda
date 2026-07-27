export declare function getRenderedChildNodes(node: Element): Iterable<Node>;
export declare function getRenderedChildren(node: Element): Generator<Element, void, unknown>;
/** @internal */
export declare function getOwnerWindow(nodeOrDocument: Node | Document | null | undefined): Window & typeof globalThis;
/** @internal */
export declare function getOwnerDocument(nodeOrDocument: Node | Document | null | undefined): Document;
export declare function isElement(node: Node): node is Element;
export declare function elementStyle(element: Element): CSSStyleDeclaration;
export declare function getComputedStyle(element: Element, pseudoElement?: string): CSSStyleDeclaration;
//# sourceMappingURL=domUtils.d.ts.map