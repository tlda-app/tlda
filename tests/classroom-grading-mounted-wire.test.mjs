import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const classroomCss = readFileSync(new URL('../src/classroom/ClassroomWorkspace.css', import.meta.url), 'utf8')

test('the mounted classroom editor exposes exactly the two grading viewport canvases', () => {
  const dom = new JSDOM(`<!doctype html>
    <style>${classroomCss}</style>
    <div class="tl-container classroom-grading-editor">
      <span>
        <div id="ordinary-document-canvas" class="tl-canvas"></div>
        <div class="tl-canvas__in-front">
          <div class="classroomGradingPanes">
            <section class="classroomGradingPane" data-grading-pane="official-solution">
              <div data-viewport-id="wm:grading:official-solution"><div class="tl-canvas tl-viewport"></div></div>
            </section>
            <section class="classroomGradingPane" data-grading-pane="student-submission">
              <div data-viewport-id="wm:grading:student-submission"><div class="tl-canvas tl-viewport"></div></div>
            </section>
          </div>
        </div>
      </span>
    </div>
  `)

  const { document } = dom.window
  const main = document.getElementById('ordinary-document-canvas')
  const gradingCanvases = [...document.querySelectorAll('[data-grading-pane] .tl-canvas')]
  assert.equal(dom.window.getComputedStyle(main).visibility, 'hidden')
  assert.equal(dom.window.getComputedStyle(main).pointerEvents, 'none')
  assert.equal(gradingCanvases.length, 2)
  assert.deepEqual(gradingCanvases.map(canvas => dom.window.getComputedStyle(canvas).visibility), ['visible', 'visible'])
})
