import { Atom } from '@tldraw/state';
import { Editor } from '../editor/Editor';
/**
 * An Atom that is scoped to the lifetime of an Editor.
 *
 * This is useful for storing UI state for tldraw applications. Keeping state scoped to an editor
 * instead of stored in a global atom can prevent issues with state being shared between editors
 * when navigating between pages, or when multiple editor instances are used on the same page.
 *
 * @public
 */
export declare class EditorAtom<T> {
    private name;
    private getInitialState;
    private states;
    constructor(name: string, getInitialState: (editor: Editor) => T);
    getAtom(editor: Editor): Atom<T>;
    get(editor: Editor): T;
    update(editor: Editor, update: (state: T) => T): T;
    set(editor: Editor, state: T): T;
}
//# sourceMappingURL=EditorAtom.d.ts.map