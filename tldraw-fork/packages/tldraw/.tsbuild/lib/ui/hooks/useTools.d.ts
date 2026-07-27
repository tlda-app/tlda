import { Editor, TLPointerEventInfo, TLShapeId } from '@tldraw/editor';
import * as React from 'react';
import { TLUiIconJsx } from '../components/primitives/TldrawUiIcon';
import { TLUiEventSource } from '../context/events';
import { TLUiOverrideHelpers } from '../overrides';
/** @public */
export interface TLUiToolItem<TranslationKey extends string = string, IconType extends string = string> {
    id: string;
    label: TranslationKey;
    shortcutsLabel?: TranslationKey;
    icon: IconType | TLUiIconJsx;
    onSelect(source: TLUiEventSource): void;
    onDragStart?(source: TLUiEventSource, info: TLPointerEventInfo): void;
    /**
     * The keyboard shortcut for this tool. This is a string that can be a single key,
     * or a combination of keys.
     * For example, `cmd+z` or `cmd+shift+z` or `cmd+u,ctrl+u`, or just `v` or `a`.
     * We have backwards compatibility with the old system, where we used to use
     * symbols to denote cmd/alt/shift, using `!` for shift, `$` for cmd, and `?` for alt.
     */
    kbd?: string;
    readonlyOk?: boolean;
    meta?: {
        [key: string]: any;
    };
}
/** @public */
export type TLUiToolsContextType = Record<string, TLUiToolItem>;
/** @internal */
export declare const ToolsContext: React.Context<TLUiToolsContextType | null>;
/** @public */
export interface TLUiToolsProviderProps {
    overrides?(editor: Editor, tools: TLUiToolsContextType, helpers: Partial<TLUiOverrideHelpers>): TLUiToolsContextType;
    children: React.ReactNode;
}
/** @internal */
export declare function ToolsProvider({ overrides, children }: TLUiToolsProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useTools(): TLUiToolsContextType;
/**
 * Options for {@link onDragFromToolbarToCreateShape}.
 * @public
 */
export interface OnDragFromToolbarToCreateShapesOpts {
    /**
     * Create the shape being dragged. You don't need to worry about positioning it, as it'll be
     * immediately updated with the correct position.
     */
    createShape(id: TLShapeId): void;
    /**
     * Called once the drag interaction has finished.
     */
    onDragEnd?(id: TLShapeId): void;
}
/**
 * A helper method to use in {@link tldraw#TLUiToolItem.onDragStart} to create a shape by dragging it from
 * the toolbar.
 * @public
 */
export declare function onDragFromToolbarToCreateShape(editor: Editor, info: TLPointerEventInfo, opts: OnDragFromToolbarToCreateShapesOpts): void;
//# sourceMappingURL=useTools.d.ts.map