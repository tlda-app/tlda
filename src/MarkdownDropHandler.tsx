/**
 * MarkdownDropHandler — handles dropping .md/.markdown files onto the canvas.
 *
 * Materializes the file into the current project and opens it in a fleet
 * doc-view at the drop position.
 */
import { useEffect } from 'react'
import type { TLViewportId } from 'tldraw'
import { useEditor } from 'tldraw'
import { createMarkdownDocviewFromContent } from './shapes/FleetPillShape'
import { materializeMarkdownChip } from './shapes/markdown-chip-materialize'
import { clientPointToPage } from './wm/viewport-coordinates'

function isMarkdownFile(file: File): boolean {
  return file.name.endsWith('.md') || file.name.endsWith('.markdown')
}

function fileNameToProjectName(filename: string): string {
  // Strip extension
  const base = filename.replace(/\.(md|markdown)$/i, '')
  // Lowercase, replace non-alphanumeric with '-'
  let name = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  // Ensure starts with letter or digit
  if (!/^[a-z0-9]/.test(name)) {
    name = 'scratch-' + name
  }
  return name
}

function dropViewportId(target: EventTarget | null): TLViewportId | undefined {
  const el = target instanceof HTMLElement ? target : null
  const viewportHost = el?.closest('[data-viewport-id]') as HTMLElement | null
  return viewportHost?.dataset.viewportId as TLViewportId | undefined
}

export function MarkdownDropHandler() {
  const editor = useEditor()

  useEffect(() => {
    function handleDragOver(e: DragEvent) {
      // If over a fleet-chat shape, let it handle the dragover.
      if ((e.target as HTMLElement | null)?.closest('.fleet-chat-shape')) return
      // Can't access filenames during dragover (browser security).
      // Allow any file drop and filter to .md in handleDrop.
      const items = e.dataTransfer?.items
      if (!items) return
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
          return
        }
      }
    }

    function handleDrop(e: DragEvent) {
      // If the drop target is inside a fleet-chat shape, let the shape's own
      // capture handler deal with it — don't create an inline-doc.
      if ((e.target as HTMLElement | null)?.closest('.fleet-chat-shape')) return

      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return

      const mdFiles: File[] = []
      for (let i = 0; i < files.length; i++) {
        if (isMarkdownFile(files[i])) mdFiles.push(files[i])
      }
      if (mdFiles.length === 0) return

      e.preventDefault()
      e.stopPropagation()

      for (const file of mdFiles) {
        const name = fileNameToProjectName(file.name)
        const title = file.name.replace(/\.(md|markdown)$/i, '') || name
        const screenPoint = { x: e.clientX, y: e.clientY }
        const pagePoint = clientPointToPage(editor, screenPoint, dropViewportId(e.target))

        const reader = new FileReader()
        reader.onload = async () => {
          const markdown = typeof reader.result === 'string' ? reader.result : ''
          const projectName = new URLSearchParams(window.location.search).get('project')
          const materialized = await materializeMarkdownChip({ markdown, title, sourcePath: file.name })
          if (!materialized.ok || !materialized.outputFile || !projectName) {
            console.warn('[MarkdownDropHandler] markdown materialize failed:', materialized.error || 'no open project')
            return
          }
          const url = `/docs/${projectName}/${materialized.outputFile}?t=${Date.now()}`
          await createMarkdownDocviewFromContent(editor, pagePoint, title, markdown, {
            materializedDoc: projectName,
            materializedFile: materialized.outputFile,
            sourceFileName: file.name,
            sourceProjectName: name,
          }, url, screenPoint)
        }
        reader.readAsText(file)
      }
    }

    document.addEventListener('dragover', handleDragOver, true)
    document.addEventListener('drop', handleDrop, true)
    return () => {
      document.removeEventListener('dragover', handleDragOver, true)
      document.removeEventListener('drop', handleDrop, true)
    }
  }, [editor])

  return null
}
