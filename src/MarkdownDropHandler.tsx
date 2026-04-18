/**
 * MarkdownDropHandler — handles dropping .md/.markdown files onto the canvas.
 *
 * Creates a tlda project from the file content and places an inline-doc shape
 * on the canvas at the drop position.
 */
import { useEffect } from 'react'
import { useEditor } from 'tldraw'

async function createInlineDoc(name: string, title: string, content: string): Promise<string> {
  // Create project (409 = already exists, that's fine — continue)
  const createRes = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, title, format: 'markdown', mainFile: 'index.md' }),
  })
  if (!createRes.ok && createRes.status !== 409) {
    const text = await createRes.text().catch(() => '')
    throw new Error(`Failed to create project: ${createRes.status} ${text}`)
  }

  // Push file content
  const pushRes = await fetch(`/api/projects/${name}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ path: 'index.md', content }] }),
  })
  if (!pushRes.ok) {
    const text = await pushRes.text().catch(() => '')
    throw new Error(`Failed to push file: ${pushRes.status} ${text}`)
  }

  return name
}

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

      const dropPoint = editor.screenToPage({ x: e.clientX, y: e.clientY })

      for (const file of mdFiles) {
        const title = file.name.replace(/\.(md|markdown)$/i, '')
        const name = fileNameToProjectName(file.name)

        const reader = new FileReader()
        reader.onload = async () => {
          // inline-doc iframes are disabled — just log
          console.log('[MarkdownDropHandler] Markdown drop ignored (inline-doc disabled):', name)
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
