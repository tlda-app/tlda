export declare function fetchCache<T>(cb: (response: Response) => Promise<T>, init?: RequestInit): (url: string) => Promise<null | T>;
export declare const resourceToDataUrl: (url: string) => Promise<null | string>;
//# sourceMappingURL=fetchCache.d.ts.map