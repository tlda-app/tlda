import { TLUiMenuItemProps } from './TldrawUiMenuItem';
/** @public */
export type TLUiMenuToolItemProps = {
    toolId?: string;
} & Pick<TLUiMenuItemProps, 'isSelected' | 'disabled'>;
/** @public @react */
export declare function TldrawUiMenuToolItem({ toolId, ...rest }: TLUiMenuToolItemProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=TldrawUiMenuToolItem.d.ts.map