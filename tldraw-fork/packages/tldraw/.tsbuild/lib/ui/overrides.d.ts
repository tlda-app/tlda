import { Editor } from '@tldraw/editor';
import { ActionsProviderProps, TLUiActionsContextType } from './context/actions';
import { TLUiToolsContextType, TLUiToolsProviderProps } from './hooks/useTools';
import { TLUiTranslationProviderProps } from './hooks/useTranslation/useTranslation';
export declare const MimeTypeContext: import("react").Context<string[] | undefined>;
/** @public */
export declare function useDefaultHelpers(): {
    addToast: (toast: Omit<import("./context/toasts").TLUiToast, "id"> & {
        id?: string | undefined;
    }) => string;
    removeToast: (id: string) => string;
    clearToasts: () => void;
    addDialog: (dialog: Omit<import("./context/dialogs").TLUiDialog, "id"> & {
        id?: string | undefined;
    }) => string;
    removeDialog: (id: string) => string;
    clearDialogs: () => void;
    msg: (id?: string | undefined) => string;
    isMobile: boolean;
    insertMedia: () => Promise<void>;
    replaceImage: () => Promise<void>;
    replaceVideo: () => Promise<void>;
    printSelectionOrPages: () => Promise<void>;
    cut: (source: import("./context/events").TLUiEventSource) => Promise<void>;
    copy: (source: import("./context/events").TLUiEventSource) => Promise<void>;
    paste: (data: ClipboardItem[] | DataTransfer, source: import("./context/events").TLUiEventSource, point?: import("@tldraw/editor").VecLike | undefined) => Promise<void>;
    copyAs: (ids: import("@tldraw/tlschema").TLShapeId[], format?: import("../..").TLCopyType) => void;
    exportAs: (ids: import("@tldraw/tlschema").TLShapeId[], opts?: {
        format?: import("@tldraw/editor").TLExportType | undefined;
        name?: string | undefined;
        scale?: number | undefined;
    }) => void;
    getEmbedDefinition: (url: string) => import("../..").TLEmbedResult;
};
/** @public */
export type TLUiOverrideHelpers = ReturnType<typeof useDefaultHelpers>;
/** @public */
export interface TLUiOverrides {
    actions?(editor: Editor, actions: TLUiActionsContextType, helpers: TLUiOverrideHelpers): TLUiActionsContextType;
    tools?(editor: Editor, tools: TLUiToolsContextType, helpers: TLUiOverrideHelpers): TLUiToolsContextType;
    translations?: TLUiTranslationProviderProps['overrides'];
}
export interface TLUiOverridesWithoutDefaults {
    actions?: ActionsProviderProps['overrides'];
    tools?: TLUiToolsProviderProps['overrides'];
    translations?: TLUiTranslationProviderProps['overrides'];
}
export declare function mergeOverrides(overrides: TLUiOverrides[], defaultHelpers: TLUiOverrideHelpers): TLUiOverridesWithoutDefaults;
/** @internal */
export declare function useMergedTranslationOverrides(overrides?: TLUiOverrides[] | TLUiOverrides): NonNullable<TLUiTranslationProviderProps['overrides']>;
export declare function useMergedOverrides(overrides?: TLUiOverrides[] | TLUiOverrides): TLUiOverridesWithoutDefaults;
//# sourceMappingURL=overrides.d.ts.map