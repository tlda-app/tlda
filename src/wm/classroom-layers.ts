/**
 * Classroom layers, as layers the window manager knows about.
 *
 * `src/classroom/bookLayers.ts` already models the set someone can see and the
 * one they are writing to — Skip's Photoshop framing, 2026-08-26 02:08:49 EDT:
 * *"you select any number of layers to be visible and one to be the currenr
 * write target"*. What it does not carry is a coordinate frame, because it did
 * not need one: each classroom layer is a separate sync room overlaying the
 * same document, so they all sit at the same origin.
 *
 * That is true and it is not a licence to hard-code it. Skip, 2026-08-13
 * 04:17:35 EDT: *"literally everything has to use its own fucking coordinate,
 * like the layer coordinate frame."* A move between two layers has to convert
 * through the relative transform, and a transform you never registered is one
 * you cannot convert through — so the move ends up assuming identity, which is
 * the assumption this removes. Declaring the layers puts the identity in the
 * model, where `wm.translate` composes it like any other, and where changing it
 * changes the moves rather than requiring someone to remember to.
 *
 * Every classroom layer is a child of `document-page`: it overlays the
 * document, and it moves when the document moves.
 */

import type { LayerId, WMCore } from './wm-core.ts'
import { ensureLayer } from './editor-wm.ts'
import { FLEET_HUD_DOCUMENT_LAYER_ID } from './fleet-hud-layer.ts'

/**
 * The WM layer id for a classroom layer.
 *
 * Namespaced rather than passed through, because `bookLayers` ids like `common`
 * and `mine` are short words in a namespace that also holds `document-page` and
 * `screen`. A collision there would not error — it would silently make two
 * different layers one layer.
 */
export function classroomLayerId(bookLayerId: string): LayerId {
  return `wm:classroom-layer:${bookLayerId}`
}

/**
 * Declare a classroom layer, idempotently. Safe to call on every render pass;
 * `ensureLayer` is defineOrUpdate.
 */
export function ensureClassroomLayer(wm: WMCore, bookLayerId: string): LayerId {
  const id = classroomLayerId(bookLayerId)
  ensureLayer(wm, id, { parent: FLEET_HUD_DOCUMENT_LAYER_ID })
  return id
}
