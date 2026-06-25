import { Editor, TLImageShape, TLShape, TLVideoShape } from '@tldraw/editor';
import * as React from 'react';
import { TLUiOverrideHelpers } from '../overrides';
import { TLUiEventSource } from './events';
/** @public */
export interface TLUiActionItem<TransationKey extends string = string, IconType extends string = string> {
    icon?: IconType | React.ReactElement;
    id: string;
    kbd?: string;
    label?: TransationKey | {
        [key: string]: TransationKey;
    };
    readonlyOk?: boolean;
    checkbox?: boolean;
    isRequiredA11yAction?: boolean;
    onSelect(source: TLUiEventSource): Promise<void> | void;
}
/** @public */
export type TLUiActionsContextType = Record<string, TLUiActionItem>;
/** @internal */
export declare const ActionsContext: React.Context<TLUiActionsContextType | null>;
/** @public */
export interface ActionsProviderProps {
    overrides?(editor: Editor, actions: TLUiActionsContextType, helpers: TLUiOverrideHelpers): TLUiActionsContextType;
    children: React.ReactNode;
}
/** @public */
export declare function supportsDownloadingOriginal(shape: TLShape, editor: Editor): shape is TLImageShape | TLVideoShape;
/** @internal */
export declare function ActionsProvider({ overrides, children }: ActionsProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useActions(): TLUiActionsContextType;
/** @public */
export declare function unwrapLabel(label?: TLUiActionItem['label'], menuType?: string): string | undefined;
//# sourceMappingURL=actions.d.ts.map