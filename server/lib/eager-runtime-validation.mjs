import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { readDocumentManifest } from './document-manifest.mjs'
import { outputDir } from './project-store.mjs'

const HTML_FILE = /\.html?$/i

function documentUrl(baseUrl, name, file, token) {
  const path = [name, ...file.split('/')].map(encodeURIComponent).join('/')
  const url = new URL(`/docs/${path}`, baseUrl)
  if (token) url.searchParams.set('token', token)
  return url.href
}

async function launchChromium() {
  const { chromium } = await import('playwright')
  return chromium.launch({ headless: true })
}

export async function validatePublishedDocumentRuntime(name, {
  baseUrl,
  token = null,
  launch = launchChromium,
  settleMs = 1800,
} = {}) {
  const out = outputDir(name)
  const manifest = readDocumentManifest(out)
  if (!manifest || !['html-pages', 'slides'].includes(manifest.view.kind)) return { checked: 0 }

  const files = []
  for (const page of manifest.pages) {
    if (!HTML_FILE.test(page.file)) continue
    try {
      await access(join(out, page.file))
    } catch (error) {
      throw new Error(`${name}: declared runtime-validation output is missing: ${page.file}`, { cause: error })
    }
    files.push(page.file)
  }
  if (files.length === 0) return { checked: 0 }

  const browser = await launch()
  let checked = 0
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    for (const file of files) {
      await page.goto(documentUrl(baseUrl, name, file, token), {
        waitUntil: 'networkidle',
        timeout: 30_000,
      })
      await page.waitForTimeout(settleMs)
      checked++
    }
  } finally {
    await browser.close()
  }
  return { checked }
}
