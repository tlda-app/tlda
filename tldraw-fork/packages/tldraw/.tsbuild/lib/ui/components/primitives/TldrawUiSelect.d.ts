import * as React from 'react';
import { TLUiIconType } from '../../icon-types';
/** @public */
export interface TLUiSelectProps {
    id: string;
    value: string;
    onValueChange(value: string): void;
    onOpenChange?(isOpen: boolean): void;
    disabled?: boolean;
    className?: string;
    children: React.ReactNode;
    'data-testid'?: string;
    'aria-label'?: string;
}
/**
 * A select dropdown component.
 *
 * @example
 * ```tsx
 * <TldrawUiSelect id="my-select" value={value} onValueChange={setValue}>
 *   <TldrawUiSelectTrigger>
 *     <TldrawUiSelectValue placeholder="Select..." />
 *   </TldrawUiSelectTrigger>
 *   <TldrawUiSelectContent>
 *     <TldrawUiSelectItem value="one" label="One" />
 *     <TldrawUiSelectItem value="two" label="Two" />
 *   </TldrawUiSelectContent>
 * </TldrawUiSelect>
 * ```
 *
 * @public
 * @react
 */
export declare function TldrawUiSelect({ id, value, onValueChange, onOpenChange, disabled, className, children, 'data-testid': dataTestId, 'aria-label': ariaLabel }: TLUiSelectProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiSelectTriggerProps {
    children: React.ReactNode;
    className?: string;
}
/**
 * The trigger button for the select dropdown.
 *
 * @public
 * @react
 */
export declare const TldrawUiSelectTrigger: React.ForwardRefExoticComponent<TLUiSelectTriggerProps & React.RefAttributes<HTMLButtonElement>>;
/** @public */
export interface TLUiSelectValueProps {
    placeholder?: string;
    icon?: TLUiIconType | Exclude<string, TLUiIconType>;
    children?: React.ReactNode;
}
/**
 * Displays the currently selected value in the trigger.
 *
 * @public
 * @react
 */
export declare function TldrawUiSelectValue({ placeholder, icon, children }: TLUiSelectValueProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiSelectContentProps {
    children: React.ReactNode;
    side?: 'top' | 'bottom';
    align?: 'start' | 'center' | 'end';
    className?: string;
}
/**
 * The dropdown content container for select items.
 *
 * @public
 * @react
 */
export declare function TldrawUiSelectContent({ children, side, align, className }: TLUiSelectContentProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiSelectItemProps {
    value: string;
    label: string;
    icon?: TLUiIconType | Exclude<string, TLUiIconType>;
    disabled?: boolean;
    className?: string;
}
/**
 * An item in the select dropdown. Styled to match TldrawUiMenuCheckboxItem.
 *
 * @public
 * @react
 */
export declare function TldrawUiSelectItem({ value, label, icon, disabled, className }: TLUiSelectItemProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TldrawUiSelect.d.ts.map