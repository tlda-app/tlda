import { TLUiToolItem } from '../../hooks/useTools';
export declare const IsInOverflowContext: import("react").Context<boolean>;
/** @public */
export interface OverflowingToolbarProps {
    children: React.ReactNode;
    orientation: 'horizontal' | 'vertical';
    sizingParentClassName: string;
    minItems: number;
    minSizePx: number;
    maxItems: number;
    maxSizePx: number;
}
/** @public @react */
export declare function OverflowingToolbar({ children, orientation, sizingParentClassName, minItems, minSizePx, maxItems, maxSizePx }: OverflowingToolbarProps): import("react/jsx-runtime").JSX.Element;
export declare function isActiveTLUiToolItem(item: TLUiToolItem, activeToolId: string | undefined, geoState: string | null | undefined): boolean;
//# sourceMappingURL=OverflowingToolbar.d.ts.map