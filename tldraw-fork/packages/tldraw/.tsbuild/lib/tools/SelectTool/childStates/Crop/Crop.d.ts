import { StateNode, TLStateNodeConstructor } from '@tldraw/editor';
export declare class Crop extends StateNode {
    static id: string;
    static initial: string;
    static children(): TLStateNodeConstructor[];
    markId: string;
    onEnter(): void;
    didExit: boolean;
    onExit(): void;
    onCancel(): void;
}
//# sourceMappingURL=Crop.d.ts.map