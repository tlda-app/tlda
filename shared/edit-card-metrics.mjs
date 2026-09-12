/**
 * How big an edit card is.
 *
 * In `shared/` because both sides create one: the browser lays out a bridge's
 * cards, and the server creates a card when an agent annotates a build whose
 * card does not exist yet. Two copies of these numbers would drift and the
 * agent-made card would be a different size from every other one.
 */
export const EDIT_CARD_W = 260
export const EDIT_CARD_H = 190
