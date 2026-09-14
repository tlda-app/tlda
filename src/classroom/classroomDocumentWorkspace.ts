/**
 * The classroom workspaces that mount a document.
 *
 * `App.tsx` skips `fetchAuthLevel()` for every standalone classroom workspace,
 * because the gradebook derives its authority from its own classroom API request
 * rather than from viewer auth. Three of those six mount a document —
 * `ProblemMarking`, `StudentWork` and `HomeworkComparisonWorkspace` — and they
 * inherited that exclusion when they were added to the predicate.
 *
 * The consequence is specific: viewer auth is never initialized on these routes,
 * so the present permission is never *known*, so a page shape's measured-height
 * write is deferred and never resolved. The shape stays at the height the build
 * declared, and a document taller than that cannot be shown.
 *
 * This names exactly that set: classroom, standalone, document-bearing, and
 * deliberately without viewer auth. It is the condition under which measured
 * geometry is applied to the local client only. Every other context keeps its
 * existing behaviour, including the deferral and its authorized resolution.
 *
 * The three are listed rather than derived from `isStandaloneWorkspaceRoute`
 * because that predicate's membership is about which routes skip the auth fetch,
 * and this one is about which of them render a document. They coincide today for
 * a reason that could stop being true — a new classroom workspace without a
 * document should not silently acquire local geometry.
 */
const CLASSROOM_DOCUMENT_WORKSPACES = ['classroom-problems', 'classroom-work', 'classroom-comparison']

export function isClassroomDocumentWorkspace(search = window.location.search): boolean {
  const workspace = new URLSearchParams(search).get('workspace')
  return CLASSROOM_DOCUMENT_WORKSPACES.includes(workspace ?? '')
}
