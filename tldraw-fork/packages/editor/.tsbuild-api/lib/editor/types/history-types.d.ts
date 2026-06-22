import { RecordsDiff, UnknownRecord } from '@tldraw/store';
/** @public */
export interface TLHistoryMark {
    type: 'stop';
    id: string;
}
/** @public */
export interface TLHistoryDiff<R extends UnknownRecord> {
    type: 'diff';
    diff: RecordsDiff<R>;
}
/** @public */
export type TLHistoryEntry<R extends UnknownRecord> = TLHistoryDiff<R> | TLHistoryMark;
/** @public */
export interface TLHistoryBatchOptions {
    /**
     * How should this change interact with the history stack?
     * - record: Add to the undo stack and clear the redo stack
     * - record-preserveRedoStack: Add to the undo stack but do not clear the redo stack
     * - ignore: Do not add to the undo stack or the redo stack
     */
    history?: 'ignore' | 'record-preserveRedoStack' | 'record';
}
//# sourceMappingURL=history-types.d.ts.map