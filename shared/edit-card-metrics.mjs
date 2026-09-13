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

/**
 * How much of a passage the excerpt may carry — in characters, because that is
 * what the server can count, sized to what the card can actually show.
 *
 * This has to live beside the card's width, because the two clips have to
 * agree. The server clips the passage around the marked span; the card then
 * clips again with `-webkit-line-clamp: 2`. **When the server's budget is
 * bigger than two lines, the card re-clips blind and can cut the mark off**,
 * which is exactly what happened: a 100-character excerpt whose marked token
 * started at character 82 rendered as two lines ending `follows from the…`,
 * the ellipsis being the CSS clamp rather than anything the server wrote. The
 * mark was correct in the data, present in the excerpt, and off the card.
 *
 * The arithmetic, so the next person can redo it when the card changes:
 *
 *   usable width  260 − 6 − 6 (card padding) − 6 (diff padding) − 2 (rule) = 240px
 *   10px monospace, advance ≈ 0.6em                                        ≈ 6px
 *   characters per line                                          240 / 6   = 40
 *   two lines                                                              = 80
 *   word wrap strands up to a word per line, so take ~10% off              = 72
 *
 * The clamp stays as the safety net. This budget is what keeps it from firing.
 */
export const EDIT_CARD_EXCERPT_CHARS = 72
