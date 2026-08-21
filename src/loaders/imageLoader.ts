import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import { TARGET_WIDTH } from '../layoutConstants'
import { PAGE_GAP } from '../layoutConstants'
import type { SvgPage, SvgDocument } from './types'
import type { PageTextData } from '../TextSelectionLayer'

const pageSpacing = PAGE_GAP

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = reject
    img.src = dataUrl
  })
}

export async function loadImageDocument(
  name: string,
  imageUrls: string[],
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading ${imageUrls.length} image pages...`)

  const textDataUrl = basePath + 'text-data.json'
  const [imageResults, textDataArray] = await Promise.all([
    Promise.all(
      imageUrls.map(async (url) => {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`Failed to fetch ${url}`)
        const blob = await resp.blob()
        const dataUrl = await blobToDataUrl(blob)
        const dims = await getImageDimensions(dataUrl)
        return { dataUrl, dims }
      })
    ),
    fetch(textDataUrl)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null) as Promise<PageTextData[] | null>,
  ])

  const pages: SvgPage[] = []
  let top = 0
  let widest = 0

  for (let i = 0; i < imageResults.length; i++) {
    const { dataUrl, dims } = imageResults[i]

    // deviceScaleFactor=2, so CSS dimensions are half the natural pixel size
    let width = dims.width / 2
    let height = dims.height / 2

    const scale = TARGET_WIDTH / width
    width = width * scale
    height = height * scale

    const pageId = `${name}-page-${i}`
    const page: SvgPage = {
      src: dataUrl,
      bounds: new Box(0, top, width, height),
      assetId: AssetRecordType.createId(pageId),
      shapeId: createShapeId(pageId),
      width,
      height,
    }

    if (textDataArray && textDataArray[i]) {
      page.textData = textDataArray[i]
    }

    pages.push(page)
    top += height + pageSpacing
    widest = Math.max(widest, width)
  }

  for (const page of pages) {
    page.bounds.x = (widest - page.bounds.width) / 2
  }

  console.log('Image document ready')
  return { name, pages, basePath, format: 'png' }
}
