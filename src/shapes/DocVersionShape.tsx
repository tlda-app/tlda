/**
 * DocVersionShape — invisible sentinel shape that records the source git commit hash
 * for the current document build. Stored as a TLDraw shape so tldraw's native
 * undo reverts the commit ref for free.
 *
 * One per room, fixed ID: shape:doc-version--sentinel
 * Renders nothing — opacity 0, 1×1px, off-screen not required.
 */
import { BaseBoxShapeUtil, T } from 'tldraw'

export class DocVersionShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'doc-version' as const
  static override props = {
    w: T.number,
    h: T.number,
    commitHash: T.string,
    timestamp: T.number,
    buildReadyAt: T.optional(T.number),
    // sourceVersion = the source.stamp mtime the build was for; monotonic per
    // source change. Used server-side to guard the sentinel write against
    // out-of-order (racy) writes so the version never jumps backward.
    sourceVersion: T.optional(T.number),
    // Build errors/warnings for the current build (JSON arrays). Persistent,
    // convergent state — the build-error/warning badges read these directly.
    warningsJson: T.optional(T.string),
    errorsJson: T.optional(T.string),
    // Mirror/shadow sync failure for this doc (JSON array). Convergent Yjs state,
    // not a fire-and-forget signal — a sync failure means the working copy may be
    // out of step with the build, which must stay visible across reconnect until
    // the next successful sync clears it. The SyncErrorPill reads this directly.
    syncErrorJson: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: 1, h: 1, commitHash: 'unknown', timestamp: 0, buildReadyAt: 0, sourceVersion: 0, warningsJson: '', errorsJson: '', syncErrorJson: '' }
  }

  override canEdit = () => false
  override canResize = () => false
  override canBind = () => false
  override isAspectRatioLocked = () => true
  override hideRotateHandle = () => true
  override hideResizeHandles = () => true
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  component(_shape: any) {
    return null
  }

  indicator(_shape: any) {
    return null
  }
}
