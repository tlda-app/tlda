export const PHONE_DOCUMENT_PANE_INDEX = 0
export const PHONE_INBOX_PANE_INDEX = 1

export function phonePaneX(docLeftPage: number, paneIndex: number, screenW: number, dx: number): number {
  return docLeftPage - paneIndex * screenW + dx
}
