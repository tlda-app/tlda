import { composerMicAppearance, documentPanelShowsProject } from './classroomUiPolicy'

function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)}`)
}

equal(documentPanelShowsProject(true), false, 'classroom hides Project')
equal(documentPanelShowsProject(false), true, 'ordinary document retains Project')
equal(composerMicAppearance(false), {
  slashed: true,
  ariaPressed: false,
  label: 'Start dictation',
}, 'off mic appearance')
equal(composerMicAppearance(true), {
  slashed: false,
  ariaPressed: true,
  label: 'Stop dictation',
}, 'on mic appearance')
console.log('classroom panel and mic policy: PASS')
