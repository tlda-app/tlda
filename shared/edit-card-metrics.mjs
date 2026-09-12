/**
 * How big an edit card is.
 *
 * In `shared/` because both sides create one: the browser lays out a bridge's
 * cards, and the server creates a card when an agent annotates a build whose
 * card does not exist yet. Two copies of these numbers would drift and the
 * agent-made card would be a different size from every other one.
 */
export const EDIT_CARD_W = 260
// Taller than it was: the card now carries what the edit did -- a headline and
// a clipped before/after -- above the files and the note. At 190 the change had
// nowhere to go, and the change is the point of the card.
export const EDIT_CARD_H = 268
