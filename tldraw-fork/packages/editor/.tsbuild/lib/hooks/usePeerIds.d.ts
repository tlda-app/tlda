/**
 * Reactive list of peer user IDs for collaborators currently shown in the UI.
 * This list includes user ids who are not on the user's current page.
 * Mirrors {@link Editor.getVisibleCollaborators} — peers fade out as they
 * transition to idle/inactive, without requiring a manual re-render.
 *
 * @returns The list of peer UserIDs
 * @public
 */
export declare function usePeerIds(): import("@tldraw/tlschema").TLUserId[];
//# sourceMappingURL=usePeerIds.d.ts.map