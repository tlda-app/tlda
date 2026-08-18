#!/usr/bin/env node
// The scratch AUTHORING path (routes, MCP tools) was deleted deliberately --
// see commit 5e8f968f8. Two build-time sites were left alone on purpose:
// convertScratchMarkdown (converts .tlda/scratch/*.md -> *.tex via pandoc)
// and the \inputscratch macro override in server/lib/build-runner.mjs, so
// documents that already contain scratch sections keep building.
//
// A comment says why they're there. A comment is an argument, and the next
// sweep arrives with one of its own -- "the authoring path is gone, so is
// this." This test is the thing that argument can't talk past: it drives a
// real project through the real runBuild() pipeline with a scratch section
// already on disk, in .tex form, and asserts the build succeeds and the
// scratch content actually reaches the rendered PDF's page count -- not that
// a file exists, that pdflatex accepted \inputscratch and moved on.
//
// Known gap, stated rather than hidden: convertScratchMarkdown's pandoc
// conversion (.md -> .tex) is NOT exercised here -- this sandbox has no
// `pandoc` binary. That function is real, undiminished risk (existing
// projects may still carry scratch/*.md that pandoc has to convert every
// build), and it is untested by this file. If pandoc becomes available,
// extend this test with a .md-sourced scratch section rather than trusting
// that the .tex-only case stands in for it.
import assert from 'assert/strict'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'tlda-scratch-build-'))
const projectsRoot = join(root, 'projects')
mkdirSync(projectsRoot, { recursive: true })

const { initProjectStore, closeProjectStore, createProject, sourceDir } =
  await import('../server/lib/project-store.mjs')
const { runBuild } = await import('../server/lib/build-runner.mjs')
const { initSyncRooms } = await import('../server/lib/sync-rooms.mjs')

await initProjectStore(projectsRoot)
initSyncRooms(projectsRoot)

const NAME = 'a-paper-with-a-scratch-section'

try {
  createProject({ name: NAME, title: NAME, mainFile: 'main.tex', format: 'pdf' })

  const src = sourceDir(NAME)
  mkdirSync(src, { recursive: true })

  // The marker version the user's own srcDir carries -- a visible placeholder
  // for vanilla (non-server) LaTeX builds. The server's buildDir override
  // (written below by the real build code) takes priority via TEXINPUTS, but
  // this must exist so the preamble-precompile step (which runs before the
  // build-scoped scratch dir is created) can resolve the \input at all.
  mkdirSync(join(src, '.tlda', 'scratch'), { recursive: true })
  writeFileSync(join(src, '.tlda', 'scratch', 'scratch-template.tex'),
    '\\usepackage{xcolor}\n' +
    '\\makeatletter\n' +
    '\\newcommand{\\inputscratch}[3]{\\par\\noindent\\fbox{\\footnotesize\\ttfamily [scratch: #2]}\\par}\n' +
    '\\makeatother\n',
  )

  // A minimal real document with an \inputscratch call -- the marker version,
  // same shape the user's own srcDir carries (see the comment at
  // build-runner.mjs's scratch-template override).
  writeFileSync(join(src, 'main.tex'),
    '\\documentclass{article}\n' +
    // The user's srcDir carries \input{.tlda/scratch/scratch-template} --
    // TEXINPUTS lists the server's buildDir override first, so pdflatex
    // resolves this to the real per-build \inputscratch definition, not any
    // marker/stub version living in srcDir.
    '\\input{.tlda/scratch/scratch-template}\n' +
    '\\begin{document}\n' +
    'Before the scratch section.\n\n' +
    '\\inputscratch{agent-note.md}{scratch:derivation}{a working derivation}\n\n' +
    'After the scratch section.\n' +
    '\\end{document}\n',
  )

  // A scratch section already converted to .tex -- this is the state a real
  // project is in today: convertScratchMarkdown already ran on some earlier
  // build (or the .md never existed and this was hand-placed), and what's on
  // disk now is what the \inputscratch macro override actually reads.
  const scratchDir = join(src, '.tlda', 'scratch')
  mkdirSync(scratchDir, { recursive: true })
  writeFileSync(join(scratchDir, 'scratch-derivation.tex'),
    'The scratch content that must reach the rendered page.\n',
  )

  await runBuild(NAME)

  // runBuild publishes a DVI, not a PDF -- SVG/PDF pages render on demand
  // from it elsewhere. The DVI existing and containing the scratch text is
  // the real proof: it is what a build with a genuinely broken \inputscratch
  // (unresolved label, or the macro override never written) would not have.
  const dviPath = join(projectsRoot, NAME, 'output', 'main.dvi')
  assert.ok(existsSync(dviPath), 'the published DVI -- exists after a build with a scratch section')

  const pdfPath = dviPath.replace(/\.dvi$/, '.pdf')
  execFileSync('dvipdf', [dviPath, pdfPath], { encoding: 'utf8' })

  // Page text extraction proves \inputscratch resolved the label and pulled
  // in real content, not just that pdflatex exited 0 -- an \inputscratch that
  // silently no-oped (e.g. the macro override never got written, or the
  // reader never ran) would still produce a DVI, just without this text.
  const text = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' })
  assert.match(text, /Before the scratch section/, 'the rendered page -- has the text before the scratch call')
  assert.match(text, /The scratch content that must reach the rendered page/,
    'the rendered page -- has the scratch section\'s actual content, proving \\inputscratch resolved it')
  assert.match(text, /After the scratch section/, 'the rendered page -- has the text after the scratch call')

  console.log('a scratch section still builds: passed')
} finally {
  await closeProjectStore()
  rmSync(root, { recursive: true, force: true })
}

// sync-rooms keeps at least one timer alive for its in-process room even
// after the work is done and the store is closed; exit explicitly rather
// than let the process hang on it.
process.exit(0)
