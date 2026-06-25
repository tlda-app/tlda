import { type TLUiMenuItemProps } from './TldrawUiMenuItem';
/** @public */
export type TLUiMenuActionItemProps = {
    actionId?: string;
} & Partial<Pick<TLUiMenuItemProps, 'disabled' | 'isSelected' | 'noClose' | 'onSelect'>>;
/** @public @react */
export declare function TldrawUiMenuActionItem({ actionId, ...rest }: TLUiMenuActionItemProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=TldrawUiMenuActionItem.d.ts.map