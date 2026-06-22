import { Vec } from '../../../../primitives/Vec';
import type { Editor } from '../../../Editor';
import { TLPointerEventInfo } from '../../../types/event-types';
import { StateNode } from '../../StateNode';
export declare class Pointing extends StateNode {
    static id: string;
    onPointerMove(info: TLPointerEventInfo): void;
    onPointerUp(): void;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    onLongPress(): void;
    complete(): void;
    cancel(): void;
}
/**
 * Checks if grid mode is enabled and snaps a point to the grid if so
 *
 * @public
 */
export declare function maybeSnapToGrid(point: Vec, editor: Editor): Vec;
//# sourceMappingURL=Pointing.d.ts.map