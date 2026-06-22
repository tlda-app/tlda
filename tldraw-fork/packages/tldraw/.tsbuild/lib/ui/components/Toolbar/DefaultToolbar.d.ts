import { ReactNode } from 'react';
/** @public */
export interface DefaultToolbarProps {
    children?: ReactNode;
    orientation?: 'horizontal' | 'vertical';
    minItems?: number;
    minSizePx?: number;
    maxItems?: number;
    maxSizePx?: number;
}
/**
 * The default toolbar for the editor. `children` defaults to the `DefaultToolbarContent` component.
 * Depending on the screen size, the children will overflow into a drop-down menu, with the most
 * recently active item from the overflow being shown in the main toolbar.
 *
 * @public
 * @react
 */
export declare const DefaultToolbar: import("react").NamedExoticComponent<DefaultToolbarProps>;
//# sourceMappingURL=DefaultToolbar.d.ts.map