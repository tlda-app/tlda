export declare class PerformanceMeasurer {
    name: string;
    private setupFn?;
    private beforeFns;
    private fns;
    private afterFns;
    private teardownFn?;
    private warmupIterations;
    private iterations;
    total: number;
    average: number;
    cold: number;
    fastest: number;
    slowest: number;
    didRun: boolean;
    totalStart: number;
    totalEnd: number;
    totalTime: number;
    constructor(name: string, opts?: {
        warmupIterations?: number | undefined;
        iterations?: number | undefined;
    });
    setup(cb: () => void): this;
    teardown(cb: () => void): this;
    add(cb: () => void): this;
    before(cb: () => void): this;
    after(cb: () => void): this;
    run(): this;
    report(): void;
    static Table(...ps: PerformanceMeasurer[]): void;
}
//# sourceMappingURL=PerformanceMeasurer.d.ts.map