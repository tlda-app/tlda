import { Signal } from '@tldraw/state';
import { InstancePresenceRecordType, TLInstancePresence } from './records/TLPresence';
import { TLUser } from './records/TLUser';
import { TLStore } from './TLStore';
/** @public */
export interface CreatePresenceStateDerivationOpts {
    /** Custom instance ID. If not provided, one is generated from the store ID. */
    instanceId?: TLInstancePresence['id'];
    /**
     * Override how presence state is built from the store and current user.
     * Defaults to {@link getDefaultUserPresence}.
     */
    getUserPresence?(store: TLStore, user: TLUser): TLPresenceStateInfo | null;
}
/**
 * Creates a derivation that represents the current presence state of the current user.
 *
 * This function returns a derivation factory that, when given a store, creates a computed signal
 * containing the user's current presence state. The presence state includes information like cursor
 * position, selected shapes, camera position, and user metadata that gets synchronized in
 * multiplayer scenarios.
 *
 * @param $user - A reactive signal containing the user information, or `null` when anonymous
 * @param opts - Optional configuration for instance ID and presence derivation
 * @returns A function that takes a store and returns a computed signal of the user's presence state
 *
 * @example
 * ```ts
 * import { createPresenceStateDerivation } from '@tldraw/tlschema'
 * import { atom } from '@tldraw/state'
 *
 * const userSignal = atom('user', { id: 'user-123', name: 'Alice', color: '#ff0000', meta: {} })
 * const presenceDerivation = createPresenceStateDerivation(userSignal)
 *
 * // Use with a store to get reactive presence state
 * const presenceState = presenceDerivation(store)
 * console.log(presenceState.get()) // Current user presence or null
 * ```
 *
 * @public
 */
export declare function createPresenceStateDerivation($user: Signal<TLUser | null>, opts?: CreatePresenceStateDerivationOpts): (store: TLStore) => Signal<TLInstancePresence | null, unknown>;
/**
 * The shape of data used to create a presence record.
 *
 * This type represents all the properties needed to construct a TLInstancePresence record.
 * It includes user information, cursor state, camera position, selected shapes, and other
 * presence-related data that gets synchronized across multiplayer clients.
 *
 * @public
 */
export type TLPresenceStateInfo = Parameters<(typeof InstancePresenceRecordType)['create']>[0];
/**
 * Creates default presence state information for a user based on the current store state.
 *
 * This function extracts the current state from various store records (instance, page state,
 * camera, pointer) and combines them with user information to create a complete presence
 * state object. This is commonly used as a starting point for custom presence implementations.
 *
 * @param store - The tldraw store containing the current editor state
 * @param user - The user information to include in the presence state
 * @returns The default presence state info, or null if required store records are missing
 *
 * @example
 * ```ts
 * import { getDefaultUserPresence } from '@tldraw/tlschema'
 *
 * const user = { id: 'user-123', name: 'Alice', color: '#ff0000', meta: {} }
 * const presenceInfo = getDefaultUserPresence(store, user)
 *
 * if (presenceInfo) {
 *   console.log('Current cursor:', presenceInfo.cursor)
 *   console.log('Selected shapes:', presenceInfo.selectedShapeIds)
 *   console.log('Camera position:', presenceInfo.camera)
 * }
 * ```
 *
 * @example
 * ```ts
 * // Common pattern: customize default presence
 * const customPresence = {
 *   ...getDefaultUserPresence(store, user),
 *   // Remove camera for privacy
 *   camera: undefined,
 *   // Add custom metadata
 *   customField: 'my-data'
 * }
 * ```
 *
 * @public
 */
export declare function getDefaultUserPresence(store: TLStore, user: TLUser): {
    selectedShapeIds: import(".").TLShapeId[];
    brush: import(".").BoxModel | null;
    scribbles: import(".").TLScribble[];
    userId: import(".").TLUserId;
    userName: string;
    followingUserId: import(".").TLUserId | null;
    camera: {
        x: number;
        y: number;
        z: number;
    };
    color: string;
    currentPageId: import(".").TLPageId;
    cursor: {
        x: number;
        y: number;
        rotation: number;
        type: string;
    };
    lastActivityTimestamp: number;
    screenBounds: import(".").BoxModel;
    chatMessage: string;
    meta: {};
} | null;
//# sourceMappingURL=createPresenceStateDerivation.d.ts.map