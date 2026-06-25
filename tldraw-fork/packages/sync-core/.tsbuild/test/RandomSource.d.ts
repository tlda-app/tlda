export declare class RandomSource {
    private _seed;
    constructor(_seed: number);
    randomInt(): number;
    randomInt(lessThan: number): number;
    randomInt(fromInclusive: number, toExclusive: number): number;
    randomAction<Result>(choices: Array<(() => Result) | {
        weight: number;
        do: () => any;
    }>, randomWeights?: boolean): Result;
    randomElement<Elem>(items: Elem[]): Elem | undefined;
}
//# sourceMappingURL=RandomSource.d.ts.map