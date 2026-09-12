/**
 * How big an edit card is.
 *
 * Its own module because both the card and the bridge's layout arithmetic need
 * it, and the layout must stay importable without pulling in the shape — which
 * needs tldraw and a served page's config to load at all.
 */
export const EDIT_CARD_W = 260
export const EDIT_CARD_H = 190
