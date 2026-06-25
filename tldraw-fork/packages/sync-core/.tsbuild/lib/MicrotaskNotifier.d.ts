/**
 * A notifier that queues its notifications to the microtask queue.
 * This is useful for avoiding race conditions where callbacks are triggered prematurely.
 */
export declare class MicrotaskNotifier<T extends unknown[]> {
    private listeners;
    notify(...props: T): void;
    register(_listener: (...props: T) => void): () => void;
}
//# sourceMappingURL=MicrotaskNotifier.d.ts.map