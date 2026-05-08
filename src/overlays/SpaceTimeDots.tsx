/**
 * SpaceTimeDots — type definitions for the changelog data.
 * The actual rendering lives in ShadowHistoryOverlay.tsx.
 */

export interface ChangelogCommit {
  hash: string
  timestamp: number
  changedPages: number[]
}
