import { Signal } from '@tldraw/state';
import { TLUserPreferences } from './TLUserPreferences';
/** @public */
export interface TLCurrentUser {
    readonly userPreferences: Signal<TLUserPreferences>;
    readonly setUserPreferences: (userPreferences: TLUserPreferences) => void;
}
/** @public */
export declare function createTLCurrentUser(opts?: {
    setUserPreferences?: ((userPreferences: TLUserPreferences) => void) | undefined;
    userPreferences?: Signal<TLUserPreferences, unknown> | undefined;
}): TLCurrentUser;
/**
 * @public
 */
export declare function useTldrawCurrentUser(opts: {
    setUserPreferences?: (userPreferences: TLUserPreferences) => void;
    userPreferences?: Signal<TLUserPreferences> | TLUserPreferences;
}): TLCurrentUser;
//# sourceMappingURL=createTLCurrentUser.d.ts.map