declare const GRID_TYPE = "my-grid-shape";
declare const COUNTER_TYPE = "my-counter-shape";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [GRID_TYPE]: {
            w: number;
            h: number;
        };
        [COUNTER_TYPE]: Record<string, never>;
    }
}
declare const REJECT_TYPE = "my-reject-shape";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [REJECT_TYPE]: {
            w: number;
            h: number;
        };
    }
}
export {};
//# sourceMappingURL=dragAndDrop.test.d.ts.map