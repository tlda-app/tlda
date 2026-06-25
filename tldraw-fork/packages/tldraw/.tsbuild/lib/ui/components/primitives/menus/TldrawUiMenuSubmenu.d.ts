import { ReactNode } from 'react';
/** @public */
export interface TLUiMenuSubmenuProps<Translation extends string = string> {
    id: string;
    label?: Translation | {
        [key: string]: Translation;
    };
    disabled?: boolean;
    children: ReactNode;
    size?: 'tiny' | 'small' | 'medium' | 'wide';
}
/** @public @react */
export declare function TldrawUiMenuSubmenu<Translation extends string = string>({ id, disabled, label, size, children }: TLUiMenuSubmenuProps<Translation>): string | number | bigint | boolean | import("react/jsx-runtime").JSX.Element | Iterable<ReactNode> | Promise<string | number | bigint | boolean | Iterable<ReactNode> | import("react").ReactElement<unknown, string | import("react").JSXElementConstructor<any>> | import("react").ReactPortal | null | undefined> | null | undefined;
/** @private */
export interface TLUiContextMenuSubProps {
    id: string;
    children: ReactNode;
}
/** @private */
export declare function ContextMenuSubWithMenu({ id, children }: TLUiContextMenuSubProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TldrawUiMenuSubmenu.d.ts.map