import type { Editor } from '../../Editor';
/**
 * A manager for ensuring correct focus across the editor.
 * It will listen for changes in the instance state to make sure the
 * container is focused when the editor is focused.
 * Also, it will make sure that the focus is on things like text
 * labels when the editor is in editing mode.
 *
 * @internal
 */
export declare class FocusManager {
    editor: Editor;
    private disposeSideEffectListener?;
    constructor(editor: Editor, autoFocus?: boolean);
    /**
     * The editor's focus state and the container's focus state
     * are not necessarily always in sync. For that reason we
     * can't rely on the css `:focus` or `:focus-within` selectors to style the
     * editor when it is in focus.
     *
     * For that reason we synchronize the editor's focus state with a
     * special class on the container: tl-container__focused
     */
    private updateContainerClass;
    private handleKeyDown;
    private handleMouseDown;
    focus(): void;
    blur({ blurContainer }?: {
        blurContainer?: boolean | undefined;
    }): void;
    dispose(): void;
}
//# sourceMappingURL=FocusManager.d.ts.map