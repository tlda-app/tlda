import { Vec } from '@tldraw/editor';
import { ElbowArrowRoute } from '../definitions';
import { ElbowArrowWorkingInfo } from './ElbowArrowWorkingInfo';
export declare class ElbowArrowRouteBuilder {
    private readonly info;
    readonly name: string;
    points: Vec[];
    constructor(info: ElbowArrowWorkingInfo, name: string);
    add(x: number, y: number): this;
    private _midpointHandle;
    midpointHandle(axis: 'x' | 'y'): this;
    build(): ElbowArrowRoute;
}
//# sourceMappingURL=ElbowArrowRouteBuilder.d.ts.map