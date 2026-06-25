/** @internal */
export declare function useThreeStackableItems(): boolean;
/** @internal */
export declare function useIsInSelectState(): boolean;
/** @internal */
export declare function useAllowGroup(): boolean;
/** @internal */
export declare function useAllowUngroup(): boolean;
export declare const showMenuPaste: boolean;
/**
 * Returns true if the number of LOCKED OR UNLOCKED selected shapes is at least min or at most max.
 */
export declare function useAnySelectedShapesCount(min?: number, max?: number): number | boolean;
/**
 * Returns true if the number of UNLOCKED selected shapes is at least min or at most max.
 * @public
 */
export declare function useUnlockedSelectedShapesCount(min?: number, max?: number): number | boolean;
export declare function useShowAutoSizeToggle(): boolean;
export declare function useHasLinkShapeSelected(): boolean;
export declare function useOnlyFlippableShape(): boolean | null;
/** @public */
export declare function useCanRedo(): boolean;
/** @public */
export declare function useCanUndo(): boolean;
/** Returns true if the current page has at least one shape. */
export declare function useHasShapesOnPage(): boolean;
/**
 * Returns true if the user is in the select tool and has at least one shape selected.
 * This corresponds to the `canApplySelectionAction()` check in actions.tsx.
 * @public
 */
export declare function useCanApplySelectionAction(): boolean;
//# sourceMappingURL=menu-hooks.d.ts.map