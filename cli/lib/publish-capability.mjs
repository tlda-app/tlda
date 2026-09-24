/**
 * Whether a published-tree inventory comes from a surface that serves its
 * canvas half raw for publish.
 *
 * The preview publish fetches every file as itself, including the app pages
 * — which needs the app route's publish-raw bypass. A surface without it
 * answers the reader shell for those pages, so the publish refuses instead
 * of staging the application as the page. The flag is a strict boolean in
 * the inventory; anything else is an old surface, not a guess.
 */
export function surfaceServesPublishRawApp(inventory) {
  return inventory?.publishRawApp === true
}
