import { RecordsDiff, Store, UnknownRecord } from '@tldraw/store';
import { TLHistoryBatchOptions, TLHistoryEntry } from '../../types/history-types';
/** @public */
export declare class HistoryManager<R extends UnknownRecord> {
    private readonly store;
    readonly dispose: () => void;
    private state;
    private readonly pendingDiff;
    private stacks;
    private readonly annotateError;
    constructor(opts: {
        annotateError?(error: unknown): void;
        store: Store<R>;
    });
    private flushPendingDiff;
    getNumUndos(): number;
    getNumRedos(): number;
    /** @internal */
    private _isReplaying;
    /** @internal */
    isReplaying(): boolean;
    /** @internal */
    _isInBatch: boolean;
    batch(fn: () => void, opts?: TLHistoryBatchOptions): this;
    _undo({ pushToRedoStack, toMark }: {
        pushToRedoStack: boolean;
        toMark?: string;
    }): this;
    undo(): this;
    redo(): this;
    bail(): this;
    bailToMark(id: string): this;
    squashToMark(id: string): this;
    /** @internal */
    _mark(id: string): void;
    clear(): void;
    /** @internal */
    getMarkIdMatching(idSubstring: string): null | string;
    /** @internal */
    debug(): {
        pendingDiff: {
            diff: RecordsDiff<R>;
            isEmpty: boolean;
        };
        redos: TLHistoryEntry<R>[];
        state: string;
        undos: TLHistoryEntry<R>[];
    };
}
//# sourceMappingURL=HistoryManager.d.ts.map