import { BindingOnChangeOptions, BindingOnCreateOptions, BindingOnShapeChangeOptions, BindingOnShapeIsolateOptions, BindingUtil, Editor, TLArrowBinding, TLArrowBindingProps, TLArrowShape } from '@tldraw/editor';
/**
 * @public
 */
export declare class ArrowBindingUtil extends BindingUtil<TLArrowBinding> {
    static type: string;
    static props: import("@tldraw/tlschema").RecordProps<TLArrowBinding>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    getDefaultProps(): Partial<TLArrowBindingProps>;
    onAfterCreate({ binding }: BindingOnCreateOptions<TLArrowBinding>): void;
    onAfterChange({ bindingAfter }: BindingOnChangeOptions<TLArrowBinding>): void;
    onAfterChangeFromShape({ shapeBefore, shapeAfter, reason }: BindingOnShapeChangeOptions<TLArrowBinding>): void;
    onAfterChangeToShape({ binding, shapeBefore, shapeAfter, reason }: BindingOnShapeChangeOptions<TLArrowBinding>): void;
    onBeforeIsolateFromShape({ binding }: BindingOnShapeIsolateOptions<TLArrowBinding>): void;
}
/** @internal */
export declare function updateArrowTerminal({ editor, arrow, terminal, unbind, useHandle }: {
    editor: Editor;
    arrow: TLArrowShape;
    terminal: 'start' | 'end';
    unbind?: boolean;
    useHandle?: boolean;
}): void;
//# sourceMappingURL=ArrowBindingUtil.d.ts.map