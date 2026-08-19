/**
 * Reading positions as they are actually held: in the per-user `fleet_prefs`
 * row on the server, under one key.
 *
 * Separate from readingPosition.ts so the arithmetic there stays free of the
 * preferences module, which reaches the fleet socket and cannot be loaded
 * outside a browser.
 */

import { getPref, setPref } from './preferences'
import { readingPositionOf, withReadingPosition } from './readingPosition'

type DocumentNode = { documentRef: { id: string; path?: string } }

/**
 * The read/write pair `openSpatialDocument` takes. One place, so the documents
 * panel and the map cannot key the same document two different ways.
 *
 * Reads are synchronous off the prefs cache, which is populated at login, so
 * opening a document never waits. A write goes to the server through setPref;
 * a lost write costs the position of one document, and the next time he reads
 * it the position is written again.
 */
export function readingPositionStore(projectName: string) {
	return {
		read: (node: DocumentNode) =>
			readingPositionOf(getPref('reading-positions'), projectName, node.documentRef),
		write: (node: DocumentNode, offset: number) => {
			const positions = getPref('reading-positions')
			const next = withReadingPosition(positions, projectName, node.documentRef, offset)
			if (next !== positions) setPref('reading-positions', next)
		},
	}
}
