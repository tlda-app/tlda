/**
 * A page is titled by its own content, never by navigation chrome.
 *
 * Measured 2026-09-15 on the course book: the manifest writer matched a
 * sidebar `chapter-title` span first, so index and every part divider
 * inherited the first chapter's title and the TOC showed one label nine
 * times — while each page's own h1.title and title tag were correct.
 * `manifestTitleFromHtml` is the precedence that fixes it: title-block
 * heading, then document title, then file name. Nav spans do not rank.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { manifestTitleFromHtml } from './tlda-manifest.mjs'

const SIDEBAR = `<nav class="sidebar"><a href="index.html">About This Book</a>`
  + `<a href="chapter-social-pressure-experiment.html"><span class="chapter-number">1</span> `
  + `<span class="chapter-title">The Social Pressure Experiment</span></a></nav>`

test('title-block heading wins over sidebar nav span and title tag', () => {
  const html = `<html><head><title>Prediction, Inference, and Causality I</title></head>`
    + `<body>${SIDEBAR}<header><h1 class="title">Prediction, Inference, and Causality I</h1></header></body></html>`
  assert.equal(manifestTitleFromHtml(html, 'index.html'), 'Prediction, Inference, and Causality I')
})

test('part divider takes its own heading, not the first chapter span', () => {
  const html = `<html><head><title>One-Sample Problems \u2013 Prediction, Inference, and Causality</title></head>`
    + `<body>${SIDEBAR}<header><h1 class="title">One-Sample Problems</h1></header></body></html>`
  assert.equal(manifestTitleFromHtml(html, 'part1-one-sample.html'), 'One-Sample Problems')
})

test('chapter numbering is preserved to match the static TOC', () => {
  const html = `<html><body>${SIDEBAR}<header><h1 class="title">`
    + `<span class="header-section-number">1</span>&nbsp;The Social Pressure Experiment</h1></header></body></html>`
  assert.equal(
    manifestTitleFromHtml(html, 'chapter-social-pressure-experiment.html'),
    '1 The Social Pressure Experiment',
  )
})

test('document title tag is the fallback, not the nav span', () => {
  const html = `<html><head><title>Sampling</title></head><body>${SIDEBAR}<p>No headings here.</p></body></html>`
  assert.equal(manifestTitleFromHtml(html, 'chapter-sampling.html'), 'Sampling')
})

test('file name is the last resort', () => {
  const html = `<html><body>${SIDEBAR}<p>No headings, no title tag.</p></body></html>`
  assert.equal(manifestTitleFromHtml(html, 'mystery-page.html'), 'mystery-page')
})
