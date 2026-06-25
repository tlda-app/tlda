import * as React from 'react';
/** @public */
export interface TLUiButtonProps extends React.HTMLAttributes<HTMLButtonElement> {
    disabled?: boolean;
    isActive?: boolean;
    type: 'normal' | 'primary' | 'danger' | 'low' | 'icon' | 'tool' | 'menu' | 'help';
    htmlButtonType?: 'button' | 'submit' | 'reset';
    tooltip?: string;
}
/** @public @react */
export declare const TldrawUiButton: React.ForwardRefExoticComponent<TLUiButtonProps & React.RefAttributes<HTMLButtonElement>>;
//# sourceMappingURL=TldrawUiButton.d.ts.map