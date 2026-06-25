import type { TLInstancePresence } from '@tldraw/tlschema';
import type { Editor } from '../../Editor';
/**
 * Tracks remote peers and exposes the collaborator-related queries used by the
 * editor and its overlays. Encapsulates the visibility clock that periodically
 * re-evaluates which collaborators should be visible based on activity.
 *
 * Accessed via {@link Editor.collaborators}.
 *
 * @public
 */
export declare class CollaboratorsManager {
    private readonly editor;
    constructor(editor: Editor);
    private _visibilityClockStarted;
    private _startVisibilityClock;
    /**
     * Drives reactive re-evaluation of {@link CollaboratorsManager.getVisibleCollaborators}.
     * Ticked on a fixed interval so callers don't need to manage their own activity timers.
     */
    private readonly _visibilityClock;
    private _getCollaboratorsQuery;
    /**
     * Returns a list of presence records for all peer collaborators.
     * This will return the latest presence record for each connected user.
     */
    getCollaborators(): TLInstancePresence[];
    /**
     * Returns a list of presence records for all peer collaborators on the current page.
     * This will return the latest presence record for each connected user.
     */
    getCollaboratorsOnCurrentPage(): TLInstancePresence[];
    /**
     * Returns a list of presence records for peer collaborators who should currently be
     * shown in the UI. Filters {@link CollaboratorsManager.getCollaborators} by activity
     * state (active / idle / inactive) and visibility rules such as following and
     * highlighted users. Re-evaluates on the visibility clock, so callers don't need to
     * drive their own activity timer.
     */
    getVisibleCollaborators(): TLInstancePresence[];
    /**
     * Returns a list of presence records for peer collaborators who should currently be
     * shown in the UI, filtered to those on the current page.
     */
    getVisibleCollaboratorsOnCurrentPage(): TLInstancePresence[];
}
//# sourceMappingURL=CollaboratorsManager.d.ts.map