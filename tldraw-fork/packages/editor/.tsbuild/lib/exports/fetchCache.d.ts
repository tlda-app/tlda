export declare function fetchCache<T>(cb: (response: Response) => Promise<T>, init?: RequestInit): (url: string) => Promise<T | null>;
export declare const resourceToDataUrl: (url: string) => Promise<string | null>;
//# sourceMappingURL=fetchCache.d.ts.map