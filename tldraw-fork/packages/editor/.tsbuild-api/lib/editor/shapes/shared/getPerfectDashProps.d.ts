import { TLDefaultDashStyle } from '@tldraw/tlschema';
/** @public */
export type PerfectDashTerminal = 'none' | 'outset' | 'skip';
/** @public */
export declare function getPerfectDashProps(totalLength: number, strokeWidth: number, opts?: {
    closed?: boolean;
    end?: PerfectDashTerminal;
    forceSolid?: boolean;
    lengthRatio?: number;
    snap?: number;
    start?: PerfectDashTerminal;
    style?: TLDefaultDashStyle;
}): {
    strokeDasharray: string;
    strokeDashoffset: string;
};
//# sourceMappingURL=getPerfectDashProps.d.ts.map