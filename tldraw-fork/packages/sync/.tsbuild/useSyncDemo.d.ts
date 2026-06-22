import { TLPresenceStateInfo, TLStore, TLStoreSchemaOptions, TLUser, TLUserStore } from 'tldraw';
import { RemoteTLStoreWithStatus } from './useSync';
/** @public */
export interface UseSyncDemoOptions {
    /**
     * The room ID to sync with. Make sure the room ID is unique. The namespace is shared by
     * everyone using the demo server. Consider prefixing it with your company or project name.
     */
    roomId: string;
    /**
     * User store for identity, presence and attribution.
     * If not provided, a default implementation based on localStorage will be used.
     */
    users?: TLUserStore;
    /** @internal */
    host?: string;
    /**
     * {@inheritdoc UseSyncOptions.getUserPresence}
     * @public
     */
    getUserPresence?(store: TLStore, user: TLUser): TLPresenceStateInfo | null;
}
/**
 * Creates a tldraw store synced with a multiplayer room hosted on tldraw's demo server `https://demo.tldraw.xyz`.
 *
 * The store can be passed directly into the `<Tldraw />` component to enable multiplayer features.
 * It will handle loading states, and enable multiplayer UX like user cursors and following.
 *
 * All data on the demo server is
 *
 * - Deleted after a day or so.
 * - Publicly accessible to anyone who knows the room ID. Use your company name as a prefix to help avoid collisions, or generate UUIDs for maximum privacy.
 *
 * @example
 * ```tsx
 * function MyApp() {
 *     const store = useSyncDemo({roomId: 'my-app-test-room'})
 *     return <Tldraw store={store} />
 * }
 * ```
 *
 * @param options - Options for the multiplayer demo sync store. See {@link UseSyncDemoOptions} and {@link @tldraw/editor#TLStoreSchemaOptions}.
 *
 * @public
 */
export declare function useSyncDemo(options: UseSyncDemoOptions & TLStoreSchemaOptions): RemoteTLStoreWithStatus;
//# sourceMappingURL=useSyncDemo.d.ts.map