// chat-attachment-store.mjs — server-side copy of chat attachment ref-array
// entries into the persistent upload directory.
//
// When a chat message carries an `attachments` ref-array with local file paths,
// the server copies each existing file into its own upload dir and rewrites the
// entry's `path` to the copied destination so the materialized /api/file URL is
// served from the server. This MUST target the persistent upload dir (the one
// /api/upload uses, honoring TLDA_UPLOAD_DIR) — writing to an ephemeral container
// dir means Fly wipes the copies on every redeploy and the URLs 404 afterward.
import fs from 'fs'
import path from 'path'

// Copy each attachment whose `path` exists on disk into `uploadDir`, returning a
// new array with copied entries' `path` rewritten to the destination (and the
// original preserved as `originalPath`). Missing files and copy failures are
// returned unchanged. Non-array / empty input is returned as-is.
export function copyAttachmentsToUploadDir(attachments, uploadDir) {
  if (!attachments || !attachments.length) return attachments
  return attachments.map(a => {
    if (a.path && fs.existsSync(a.path)) {
      try {
        fs.mkdirSync(uploadDir, { recursive: true })
        const name = `${Date.now()}-${path.basename(a.path)}`
        const dest = path.join(uploadDir, name)
        fs.copyFileSync(a.path, dest)
        return { ...a, path: dest, originalPath: a.path }
      } catch { /* keep original */ }
    }
    return a
  })
}
