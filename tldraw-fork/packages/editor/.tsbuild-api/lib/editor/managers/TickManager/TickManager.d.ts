import type { Editor } from '../../Editor';
/** @internal */
export declare class TickManager {
    editor: Editor;
    constructor(editor: Editor);
    cancelRaf?: (() => void) | null;
    isPaused: boolean;
    now: number;
    start(): void;
    tick(): void;
    dispose(): void;
}
//# sourceMappingURL=TickManager.d.ts.map