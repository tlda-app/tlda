import { Editor, TLPageId, TLShapeId, TLStore, VecModel } from 'tldraw';
import { RandomSource } from './RandomSource';
export type Op = {
    type: 'create-box';
    parentId?: TLShapeId;
    x: number;
    y: number;
    width: number;
    height: number;
} | {
    type: 'create-frame';
    x: number;
    y: number;
    width: number;
    height: number;
} | {
    type: 'group-selection';
} | {
    type: 'ungroup-selection';
} | {
    type: 'create-arrow';
    start: VecModel;
    end: VecModel;
} | {
    type: 'delete-shape';
    id: TLShapeId;
} | {
    type: 'create-page';
    id: TLPageId;
} | {
    type: 'delete-page';
    id: TLPageId;
} | {
    type: 'undo';
} | {
    type: 'redo';
} | {
    type: 'switch-page';
    id: TLPageId;
} | {
    type: 'select-shape';
    id: TLShapeId;
} | {
    type: 'deselect-shape';
    id: TLShapeId;
} | {
    type: 'move-selection';
    dx: number;
    dy: number;
} | {
    type: 'delete-selection';
} | {
    type: 'move-selected-shapes-to-page';
    pageId: TLPageId;
} | {
    type: 'mark-stopping-point';
};
export declare class FuzzEditor extends RandomSource {
    readonly id: string;
    readonly store: TLStore;
    editor: Editor;
    constructor(id: string, _seed: number, store: TLStore);
    ops: Op[];
    getRandomShapeId({ selected }?: {
        selected?: boolean;
    }): TLShapeId | undefined;
    getRandomOp(): Op;
    applyOp(op: Op): void;
}
//# sourceMappingURL=FuzzEditor.d.ts.map