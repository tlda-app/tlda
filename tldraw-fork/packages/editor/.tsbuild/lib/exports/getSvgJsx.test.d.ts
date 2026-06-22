declare const TEST_SHAPE_TYPE = "test-shape";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [TEST_SHAPE_TYPE]: {
            w: number;
            h: number;
            x: number;
            y: number;
            isContainer?: boolean;
        };
    }
}
export {};
//# sourceMappingURL=getSvgJsx.test.d.ts.map