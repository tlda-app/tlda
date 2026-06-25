/**
 * The DOM requires that all IDs are unique. We often use e.g. shape IDs in the dom, but this isn't
 * safe: if tldraw is rendered twice, or an SVG export is taking place, the IDs will clash and the
 * browser will do weird things. This type is used to mark IDs that are unique and safe to use.
 *
 * Use {@link useUniqueSafeId} to generate a unique safe ID. Use {@link useSharedSafeId} to generate
 * the same ID across multiple components, but unique within a single tldraw/editor instance.
 *
 * @public
 */
export type SafeId = string & {
    __brand: 'SafeId';
};
declare module 'react' {
    interface HTMLProps<T> {
        id?: SafeId;
    }
    interface SVGProps<T> {
        id?: SafeId;
    }
}
/** @public */
export declare function suffixSafeId(id: SafeId, suffix: string): SafeId;
/**
 * React's useId hook returns a unique id for the component. However, it uses a colon in the id,
 * which is not valid for CSS selectors. This hook replaces the colon with an underscore.
 *
 * @public
 */
export declare function useUniqueSafeId(suffix?: string): SafeId;
/**
 * React's useId hook returns a unique id for the component. However, it uses a colon in the id,
 * which is not valid for CSS selectors. This hook replaces the colon with an underscore.
 *
 * @public
 */
export declare function useSharedSafeId(id: string): SafeId;
/** @public */
export declare function sanitizeId(id: string): string;
export declare function IdProvider({ children }: {
    children: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=useSafeId.d.ts.map