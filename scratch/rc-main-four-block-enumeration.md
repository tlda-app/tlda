# What `main` does inside the other four blocks the branch replaces {#enumeration}

Compared `4490e53ac` (`main`) with the current `pdf-document-architecture` tip,
`4a35bf534`. The four requested files are unchanged between that tip and
`b8cc1550c`, the branch point used in the worked example.

## `cli/tlda.mjs` — project creation and operational commands {#enum-cli}

| what `main` does | status | note |
|---|---|---|
| Records document roots with per-root formats and sends them when projects are created or updated | **DROPPED** | the branch replaces the old `format` field with transport axes, but does not carry the root declaration alongside them |
| Prints every tracked file excluded from a submitted revision because no document root reaches it | **DROPPED** | `printDocumentsNotInRevision`; otherwise a successful push silently omits the file |
| Relinks an existing project without requiring roots again, preserving its recorded roots, format and main file, including an empty root declaration | **DROPPED** | the branch requires a root and re-infers the project description |
| Passes `--server` to the daemon call that performs the history-seed push, including scratch creation | **DROPPED** | the branch applies the selected server to API work but not to this push |
| Preflights a source link before project mutation and passes `acceptContainedServerHistory` / `forceRebuild` through activation | **DROPPED** | branch performs the link directly and has neither option |
| `tlda project add`: obtains a document from another branch when requested, stages an untracked document, appends its root without rewriting existing roots, and immediately submits it | **DROPPED** | whole command absent; only the final submission retries, so filesystem mutation is not replayed |
| `tlda project merge`: fetches or accepts the app's shadow history and replays it commit-by-commit onto a real branch, with status/continue/abort and `--ff-only` | **DROPPED** | whole command absent; it is intentionally outside the generic retry wrapper |
| Deleting a project also removes its machine-local source binding and reports a partial failure if only the server deletion succeeded | **DROPPED** | branch deletes the server project only |
| Infers a project from object-valued daemon bindings, refuses an ambiguous checkout, and refuses an unbound checkout instead of guessing its basename | **DROPPED** | branch reads binding objects as strings and falls back to the directory name; both failures are silent when the guess names a real project |
| A mint reports the assigned agent name, reports its tmux session separately, and calls out collision rotation | **DROPPED** | branch prefers the tmux-session string, which can differ from the assigned name |
| `agent attach` distinguishes a recorded agent whose tmux session is absent from a nonexistent agent | **DROPPED** | branch hands the failure to tmux |
| A share URL is probed against its target box before it is printed; rejection and no response are reported differently | **DROPPED** | branch prints without testing the target token |
| Classroom setup accepts course-supplied generator/filter/support files/extensions/work directory, records instructor identity, and prints a registration URL that includes the project to continue into | **DROPPED** | branch hard-codes one course's renderer and its registration URL omits the project |
| The developer URL command refuses to print an unreachable localhost URL and prefers the URL written by the worktree server | **carried** | `cmdDevUrl` exists on both refs; only surrounding placement changes |
| Book, scratch, HTML, QMD, Markdown and slide creation describe the same formats using `sourceFormat`, `renderer`, and `documentFormat` | **new on branch** | this is the intended transport-axis replacement, not a lost behavior |
| Creates a PDF project after checking that its declared root is an existing PDF and submits it through the ordinary source link | **new on branch** | no PDF creation branch on `main` |

Renamed fields, altered help prose, and reworded log/error lines that do not change control flow are noise. The silent-loss items above are all absent at `dc30b1805`; representative introductions on `main` are `878385f0a` (excluded-document report), `f35d73066` (relink without restating documents), `768ae40f4` (add and merge), `13225e980` (delete unlinks), `23d34bc2b` (assigned mint name), `67ecf5422` (share-token probe), and `174c713c3` / `4a01a1545` / `f25bef1df` (classroom setup and continuation).

## `src/App.tsx` — document dispatch and the index {#enum-app}

| what `main` does | status | note |
|---|---|---|
| Chooses HTML, slides, PNG or SVG loading from the built view format | **carried** | the branch moves the dispatch into `loadDocumentFromManifest` |
| For PNG, probes beyond the recorded page count to discover extra rendered pages | **DROPPED** | no equivalent probe in the branch registry path |
| Keeps the manifest display title after loading | **carried** | title assignment remains after registry loading |
| Refetches a full project config when the index manifest lacks SVG targets; requests inline page info for HTML | **carried by replacement** | the branch's index entries contain `documentManifest`, so it accepts them only when that manifest is present and otherwise refetches |
| Unmounts the project picker synchronously before document loading begins | **DROPPED** | `flushSync` is absent, so picker and document history requests can overlap |
| Aborts project-history batch requests when their effect is replaced/unmounted | **DROPPED** | the branch removes the request controller and its abort-specific catch |
| Installs classroom metadata for the current document surface | **DROPPED** | `useClassroomManifest` absent |
| Wraps a standalone document in its classroom layers and overlays | **DROPPED** | branch mounts `SvgDocumentEditor` directly instead of `DocumentWithLayers` |
| Keeps the identity picker on a book surface | **DROPPED** | branch removes it from the book phase |
| Serves the one-use classroom device-transfer workspace | **DROPPED** | route and component absent |
| Mounts the shared standalone chat panel on the index, including its real filter pane, composer and voice control | **DROPPED / replaced by older equivalent** | branch restores a hand-built 24-row chat/composer. It can send and dictate, but it is not the shared chat and has no equivalent filter pane |
| Selects book membership with `format === 'book'` | **carried** | branch uses `documentFormat === 'book'` |

All dropped symbols tested above are zero at `dc30b1805` and on the branch. They were later additions to `main`: `c91a2390d` (shared index chat), `f3282a838` (classroom manifest), `b26bda800` (device transfer), `f59ad24d0` (picker unmount), and `8a9b20d17` (layers on the document surface). The PNG probe and slide/image dispatch entered `main` when the architecture merge was reverted by `281e72172`; the registry carries dispatch but not the extra-page probe.

## `src/BookViewer.tsx` — book member dispatch {#enum-book-viewer}

| what `main` does | status | note |
|---|---|---|
| Loads ordinary HTML, slides, and SVG book members according to the rendered view, including QMD decks | **carried** | the branch delegates the same format choice to `loadDocumentFromManifest` |
| Lets a navigation request switch a chapter between its ordinary view and its slide accessory, including same-member variant changes | **DROPPED** | `activeVariant` and the variant-aware `switchTo` path are absent |
| Resolves cross-member navigation by file and path, not only the member key/name | **DROPPED** | branch removes `findBookMemberIndex(..., targetPath)` |
| Fetches SVG targets from the project record, so page filenames use the TeX base rather than the project slug | **carried by replacement** | branch consumes targets already encoded in each member's document manifest |
| Shows a refused member as an explicit load error instead of an empty book | **DROPPED** | branch logs the exception and leaves the previous/null document on screen |
| Downloads every member for airplane use and exposes loading/progress/error/ready state through `BookContext` | **DROPPED** | whole cache path absent |
| Opens the active member's classroom layer rooms, passes annotation visibility into the editor, and renders the overlays | **DROPPED** | whole `useDocumentLayers` path absent |
| Shows the classroom identity badge on a classroom book | **DROPPED** | badge and surface test absent |
| Compare mode pairs the active member's first HTML page with a comparison document | **carried** | branch takes the first page from manifests/API config instead of two `page-info.json` fetches |
| Maintains one sync room per active member and forwards anchors after the member loads | **carried** | same room id and pending-anchor mechanism remain |

Every dropped symbol is zero at `dc30b1805` and on the branch. The branch predates, rather than rejects, `2d4657c36` (slide accessories), `3e1cab370` (visible load errors), and the later classroom/airplane additions.

## `server/unified-server.mjs` — server, document, fleet and daemon paths {#enum-server}

| what `main` does | status | note |
|---|---|---|
| Prevents callers from overriding the project selected by `sendProjectSourceDaemon` | **DROPPED** | main spreads params first and authoritative `project` last; branch reverses them |
| Projects runtime liveness into the durable runtime store and clears unrouted native descendants when their parent disappears | **DROPPED** | branch restores private `_aliveAgents` / thinking / compacting maps instead |
| Gives search its own store/client, binds caller-sensitive selectors to request context, returns agent-identity results, and applies row filters in the bounded search path | **DROPPED** | branch falls back to the shared fleet store and older post-filtering path; failures return plausible empty/incomplete searches |
| Sends return notices on login/reanimation only after a real away interval and retains a pending notice across wake | **DROPPED** | branch has a different reanimation notice retry, but not the ordinary return-notice path |
| Measures unanswered fleet WebSocket frames from arrival through completion | **DROPPED** | no frame-stall tracker on branch |
| Treats only MCP harness sockets as notification-delivery channels | **DROPPED** | branch treats every open fleet socket as a notification channel |
| Accepts an explicit negative MCP notification acknowledgement | **DROPPED** | branch only accepts positive acknowledgements |
| Classifies notification failure symptoms and reports them to the owning daemon | **DROPPED** | branch substitutes a wake queue/breaker and does not report these symptoms |
| Reads the MCP acknowledgement deadline as a duration-with-unit from server configuration | **DROPPED** | branch reads a numeric environment variable with a 2-second default |
| Broadcasts a newly stored event immediately to matching subscription observers, not only direct recipients | **DROPPED** | a matching observer with an open panel can remain stale |
| Batches subscription wakes until the policy deadline and first checks that matching mail is still unread | **DROPPED** | branch leaves batch bookkeeping without this wake function |
| Re-notifies eligible recipients after an amendment | **DROPPED** | amendment is stored/broadcast but no amendment wake is scheduled |
| Resolves all subscription matches once per event, including non-direct matches, rather than once per recipient | **DROPPED** | branch's per-recipient query changes the meaning/cost for observer subscriptions |
| Enforces and reports `max_recipients` before a filtered chat fans out | **DROPPED** | branch can fan out without the caller's cap |
| Changes an existing subscription's immediate/batch/hold policy and validates batch durations | **DROPPED** | whole `subscription-policy` message handler absent |
| Resolves uploaded local images through the contained local-image resolver | **DROPPED** | branch accepts any existing absolute path, including outside the permitted roots |
| Decodes the project segment in `/docs/...` without allowing encoded separators or dot segments | **DROPPED** | branch uses the raw URL segment; encoded project names fail, while separator-like names are not normalized through the common check |
| Filters the document manifest by classroom principal and enforces classroom access on document and source WebSocket rooms | **DROPPED** | branch exposes the unfiltered manifest and omits both upgrade checks |
| Serializes source-proposal admission per project, validates the daemon proposal ref/revision, records the editor, and admits it through the lifecycle | **DROPPED** | both the socket-side serializer and daemon `source-proposal-admit` handler are absent |
| On login replay, checks that the replayed route still names the same daemon before reusing it | **DROPPED** | branch can replay a stale route |
| Serves shadow SVG pages with their TeX-base coordinate and validates live page targets/page bounds with specific failures | **DROPPED / partly replaced** | branch's manifest serving carries the format dispatch, but drops the shadow TeX-base argument and collapses target/bounds checks |
| Reads Markdown source columns through resolved project roots | **DROPPED** | branch reads directly from the project's single source directory, bypassing the per-column root |
| Uses the generated document manifest for slide capability and HTML page navigation | **new on branch** | intended document-architecture replacement; main uses `viewFormat` and `page-info.json` |
| Preserves generic heading cleanup for HTML previous/next navigation | **DROPPED** | branch hard-codes `Lab` / `Lecture` stripping |
| Applies configured root redirect and configured application title to the served shell | **DROPPED** | both server-level presentation settings absent |
| Builds the session-history search index after manifest generation | **DROPPED** | child-process invocation absent, so new session history stops entering that index |

The server rows marked dropped are not evidence of a rejection by this branch: every representative symbol queried (`syncRuntimeProjection`, `FleetSearchClient`, `agentReturnNoticeIfAway`, `createFleetFrameStallTracker`, `openMcpSocketsForAgent`, `resolveLocalImage`, `docsProjectName`, `classroomRoomAccess`, `sourceProposalChains`, `refuseMcpWakeNotification`, `reportNotificationSymptom`, `subscription-policy`, `queueDirectSubscriptionBatchWake`, `maxRecipients`, `source-proposal-admit`, `build-session-history-index`, `rootRedirect`, and `appTitle`) is zero at `dc30b1805` and on the branch, and present on `4490e53ac`. Representative introductions include `a846f27ba` (return notices), `a4a2311d4` (isolated search), `58ed9548e` (runtime projection), and `901374022` (frame-stall tracking).

## Positive controls and drift conclusion {#enum-controls}

Every ref query used a token known to occur in that file. Counts are literal
occurrences; the current branch has the same counts as `b8cc1550c` for these files.

| file / token | `dc30b1805` | `4490e53ac` | branch |
|---|---:|---:|---:|
| `cli/tlda.mjs` / `async function main` | 1 | 1 | 1 |
| `src/App.tsx` / `function App` | 1 | 1 | 1 |
| `src/BookViewer.tsx` / `function BookViewer` | 1 | 1 | 1 |
| `server/unified-server.mjs` / `server.listen` | 1 | 1 | 1 |

For all four files, the behaviors that would disappear silently are drift after
the merge-base. The branch did not remove them: it never contained them. Porting
the document-manifest dispatch therefore also has to carry these later behaviors
forward, while leaving the explicitly replaced format-field and loader plumbing
to the registry.
