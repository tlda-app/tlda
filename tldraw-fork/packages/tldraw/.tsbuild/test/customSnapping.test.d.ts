import { VecModel } from '@tldraw/editor';
declare const TEST1_TYPE = "test1";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [TEST1_TYPE]: {
            w: number;
            h: number;
            boundsSnapPoints: VecModel[] | null;
        };
    }
}
declare const TEST2_TYPE = "test2";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [TEST2_TYPE]: {
            w: number;
            h: number;
            ownHandle: VecModel;
            handleOutline: VecModel[] | 'default' | null;
            handlePoints: VecModel[] | 'default';
            selfSnapOutline: VecModel[] | 'default';
            selfSnapPoints: VecModel[] | 'default';
            handleSnapType?: 'point' | 'align';
        };
    }
}
declare const BEZIER_TYPE = "bezier";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [BEZIER_TYPE]: {
            start: VecModel;
            cp1: VecModel;
            cp2: VecModel;
            end: VecModel;
        };
    }
}
export {};
//# sourceMappingURL=customSnapping.test.d.ts.map