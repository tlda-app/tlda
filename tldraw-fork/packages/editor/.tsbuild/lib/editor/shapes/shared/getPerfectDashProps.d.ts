import { TLDefaultDashStyle } from '@tldraw/tlschema';
/** @public */
export type PerfectDashTerminal = 'skip' | 'outset' | 'none';
/** @public */
export declare function getPerfectDashProps(totalLength: number, strokeWidth: number, opts?: {
    style?: TLDefaultDashStyle;
    snap?: number;
    end?: PerfectDashTerminal;
    start?: PerfectDashTerminal;
    lengthRatio?: number;
    closed?: boolean;
    forceSolid?: boolean;
}): {
    strokeDasharray: string;
    strokeDashoffset: string;
};
//# sourceMappingURL=getPerfectDashProps.d.ts.map