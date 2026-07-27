import { Box, Editor } from '@tldraw/editor';
import React from 'react';
/** @public */
export interface TLUiContextualToolbarProps {
    children?: React.ReactNode;
    className?: string;
    isMousingDown?: boolean;
    getSelectionBounds(): Box | undefined;
    changeOnlyWhenYChanges?: boolean;
    label: string;
}
/**
 * A generic floating toolbar that can be used for things
 * like rich text editing, image toolbars, etc.
 *
 * @public @react
 */
export declare function TldrawUiContextualToolbar({ children, className, isMousingDown, getSelectionBounds, changeOnlyWhenYChanges, label }: TLUiContextualToolbarProps): import("react/jsx-runtime").JSX.Element;
/** @internal */
export declare function rectToBox(rect: DOMRect): Box;
export declare function getToolbarScreenPosition(editor: Editor, toolbarElm: HTMLElement, getSelectionBounds: () => Box | undefined): {
    x: number;
    y: number;
} | undefined;
export declare function useToolbarVisibilityStateMachine(changeOnlyWhenYChanges: boolean): {
    isVisible: boolean;
    isInteractive: boolean;
    show: () => void;
    hide: (immediate?: boolean) => void;
    move: (x: number, y: number, immediate?: boolean) => void;
    position: {
        x: number;
        y: number;
    };
};
//# sourceMappingURL=TldrawUiContextualToolbar.d.ts.map