/**
 * DocVersionShape — invisible sentinel shape that records the source git commit hash
 * for the current document build. Stored as a TLDraw shape so tldraw's native
 * undo reverts the commit ref for free.
 *
 * One per room, fixed ID: shape:doc-version--sentinel
 * Renders nothing — opacity 0, 1×1px, off-screen not required.
 */
import { BaseBoxShapeUtil, T, type TLPropsMigrations } from 'tldraw'
import {
  DOC_VERSION_RETIRED_PROP_MIGRATION_ID,
  stripRetiredDocVersionProps,
} from '../../shared/shapes/doc-version-migrations.mjs'

export class DocVersionShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'doc-version' as const
  static override props = {
    w: T.number,
    h: T.number,
    commitHash: T.string,
    timestamp: T.number,
    buildReadyAt: T.optional(T.number),
    sourceRevision: T.optional(T.string),
    acceptSeq: T.optional(T.number),
    // Build errors/warnings for the current build (JSON arrays). Persistent,
    // convergent state — the build-error/warning badges read these directly.
    warningsJson: T.optional(T.string),
    errorsJson: T.optional(T.string),
    syncErrorJson: T.optional(T.string),
  }
  static override migrations: TLPropsMigrations = {
    sequence: [{
      id: DOC_VERSION_RETIRED_PROP_MIGRATION_ID,
      up: stripRetiredDocVersionProps,
      down: 'none' as const,
    }],
  }

  getDefaultProps() {
    return { w: 1, h: 1, commitHash: 'unknown', timestamp: 0, buildReadyAt: 0, sourceRevision: '', acceptSeq: 0, warningsJson: '', errorsJson: '', syncErrorJson: '' }
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

  getIndicatorPath() {
    return undefined
  }

  indicator(_shape: any) {
    return null
  }
}
