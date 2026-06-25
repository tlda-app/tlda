import { type TLUiMenuCheckboxItemProps } from './TldrawUiMenuCheckboxItem';
/** @public */
export type TLUiMenuActionCheckboxItemProps = {
    actionId?: string;
} & Pick<TLUiMenuCheckboxItemProps, 'disabled' | 'checked' | 'toggle'>;
/** @public @react */
export declare function TldrawUiMenuActionCheckboxItem({ actionId, ...rest }: TLUiMenuActionCheckboxItemProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=TldrawUiMenuActionCheckboxItem.d.ts.map