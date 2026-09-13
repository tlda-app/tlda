# What `POST /api/projects/:name/promote` actually does

All file/line references are `main` (read via `git show main:…`), 2026-09-12.

## 1. What it promotes, from where to where, with what preconditions

**Shape: a pull, server-to-server.** The destination server is asked to promote;
it then fetches the artifact from the source itself. The caller supplies only
`{ sourceEnvironment, revision }` in the body — never bytes.

`server/routes/projects.mjs`, the `/:name/promote` handler:

1. `validatePromotionName(name)`.
2. `getServerUrl(sourceEnvironment)` → resolved through the **destination's own**
   environments config, then `validatePromotionSourceOrigin`.
3. `fetch` of `GET /api/projects/:name/promotion-export/:revision` on that
   origin, with `authorization: Bearer <TLDA_PROMOTION_EXPORT_TOKEN>`, 300s
   timeout.
4. Requires `content-type: application/vnd.tlda.promotion-v2`.
5. `importProjectPromotionStream(...)`.
6. `emitGlobalEvent('project-changed')`; `201` if promoted, `200` if not.
   Every failure is `409` with `{ error }`.

**What travels** (`writeProjectPromotionStream`, header + concatenated members):

- a git bundle of `refs/tlda/source/<name>` from the project's
  `.source-lifecycle/git`
- `build.log`
- every regular file under `output/`
- `project.json` filtered to `METADATA_KEYS`
- the one accepted revision's lifecycle row

**Preconditions on the source side:**

- `revision` matches `/^[0-9a-f]{40}$/` — exact, no symbolic refs.
- The project's accepted revision **is** that revision, and its lifecycle status
  is terminal `success` (`acceptedIdentity`). Re-checked after the snapshot;
  a change mid-snapshot aborts.
- No symlinks and no non-regular files anywhere under `output/`.
- `TLDA_PROMOTION_EXPORT_TOKEN` must be set, or `promotionExportHeaders()`
  throws.

**Preconditions on the destination side** (`validateStreamHeader` +
`importProjectPromotionStream`):

- header `version === 2`; `sourceEnvironment`/`name`/`revision` match what the
  caller asked for; no unexpected keys; per-member sha256 verified as written;
  no trailing bytes.
- `lifecycle.build.state ∈ {built, not_required}`.
- exactly one bundle and one build log.
- the imported bundle's head **is** `revision` and its tree matches the header.
- for `format === 'qmd'`, accepted source is materialized into `source/`.
- **the project must not already exist** — see below.
- activation is a single `rename` of a staged `.promotion-*` dir; failure before
  that leaves nothing.

It does **not** touch checkout, bindings, classroom, rooms, or submissions
(there is a test asserting exactly that).

## 2. Was it what put `4244d363` on `pic` on 09-10? No — but it is fully configured

**The evidence that it was not promotion.** `4244d363` lives in the course repo
(`~/work/teaching/qtm285-1`, branch `tlda/qtm285-course`) with subject
`tlda settled edit cluster`. That string is written by
`daemon/git-project-sync.mjs:474` — the **daemon settle path**. The promote
endpoint ships a bundle of an already-existing ref and authors no commit at
all, let alone one with that subject. And nothing anywhere calls the endpoint:
zero callers in `cli/`, `bin/`, `scripts/`, or the rest of the tree.

**The configuration, however, is complete and live.** An earlier version of
this note claimed the shared secret and the peer store URL were set nowhere.
That was wrong, and wrong by a bad instrument: it grepped the repository, which
cannot see `fly secrets`. Measured directly with `fly secrets list`:

| box | fly app | `TLDA_PROMOTION_EXPORT_TOKEN` | `TLDA_PROMOTION_SOURCE_URL` |
|---|---|---|---|
| `pic` | `tlda-pic` | `e766a4028a39617d`, Deployed | `1b34fb2b56c148cf`, Deployed |
| `pic-preview` | `pic-preview` | `e766a4028a39617d`, Deployed | — |
| `pic-dev` | `tlda-pic-dev` | `e766a4028a39617d`, Deployed | — |

**The export-token digest is identical on all three**, so the shared secret is
genuinely shared. Only `pic` carries a source URL, which is right — it is the
only destination.

And `config/deployments/pic/daemon.yaml` **does** declare the peer: a
`pic-preview` environment whose `database` and `store` are the sentinel
`__TLDA_PROMOTION_SOURCE_URL__`. `scripts/fly-entrypoint-live.sh:67` runs
`scripts/install-private-environment-url.mjs`, which substitutes
`TLDA_PROMOTION_SOURCE_URL` and **throws if it is unset**. The entrypoint is
`set -e`, so **`pic` could not boot without it.** `pic` is up and serving, which
is independent proof the value is there.

So a caller passes `sourceEnvironment: "pic-preview"` — that is the env key the
destination resolves.

**Conclusion.** This is not an unexercised sketch with missing plumbing. It is a
fully provisioned, secret-backed, boot-enforced path with **no button**. The
config is not the gap; §3 is.

> **Superseded, 2026-09-12.** §3 below describes the defect as it was found.
> It is fixed: `importProjectPromotionStream` now republishes over an existing
> project, carrying forward everything the stream does not itself carry, and
> `tlda project promote` is the caller. §3 is kept because it is the reason the
> rest of this document exists and the reason the fix looks the way it does —
> not as a description of current behaviour. The v1/v2 table is still current:
> the v1 pair remains dead code with no production caller.

## 3. The finding that shaped the caller: it could not re-publish

`importProjectPromotionStream` opens with:

```js
const destination = join(projectsRoot, name)
if (existsSync(destination)) throw new Error(`Project "${name}" already exists`)
```

There is no update path and no idempotent path. **It can only create a project
that is absent on the destination.** Promoting a newer revision of a project
already on `pic` is a `409`.

This looks like a guard dropped in a rewrite rather than a decision:

| | idempotent retry | streaming | called by the route |
|---|---|---|---|
| v1 `exportProjectPromotion` / `importProjectPromotion` | **yes** — `existingPromotionMatches` → `{ alreadyPromoted: true }`, and a differing retry refuses | no (base64 in one JSON blob) | **no** |
| v2 `writeProjectPromotionStream` / `importProjectPromotionStream` | **no** | yes | **yes** |

The v1 pair has **zero production callers** — only tests. And five of the
suite's twenty-one tests (`identical retry is idempotent and differing retry
refuses`, `same revision with different existing output is not an identical
retry`, `activation race preserves the winner`, and two others) exercise
**only** the dead v1 path. So the tests that cover re-promotion cover the
function nobody calls, which is why the gap reads as covered.

## 4. What the test suite does and does not establish

Twenty-one tests, and they are genuinely thorough on the stream format:
truncation, trailing data, member corruption, traversal, duplicates, size
overruns, symlink refusal, backpressure past the v1 string limit, destination
disconnect, activation races, post-activation index failure.

They call `writeProjectPromotionStream` and `importProjectPromotionStream`
**from one process**, over an in-memory stream. So per `AGENTS.md` §"Prove the
wire, not the two ends": the sender and the receiver are proven; the wire is
not. Never exercised by any test or any run:

- the `/promote` and `/promotion-export/:revision` routes themselves
- `requirePromotionExport` against a live request
- `getServerUrl(<peer env>)` resolution on a deployed box
- `validatePromotionSourceOrigin` against a real origin
- `indexPromotedProject` via `onActivated`
- HTTP transport, the content-type check, and the 300s timeout

## 5. `scripts/course-release.mjs` — I called this a second instance and I was wrong

**Retracted 2026-09-12.** What this section said: that `course-release.mjs` also
has no caller and no contract file, so "there are two documented publishing
mechanisms and neither has ever been invoked."

**The second half was false and the first half was misleading.**

**The contract exists.** `~/work/teaching/qtm285-1/course-release.json` — 5,375
bytes, mtime 2026-09-12 06:38, top-level keys `version`, `sourceRevision`,
`appSha`, `releaseRoot`, `previousManifest`, `artifacts`, which are exactly the
keys `docs/course-release.md` documents. `class-build-pm` caught this; I then
confirmed it on disk myself rather than relaying it.

**It does not live in this repository by design** — it names one course's
artifacts, so it belongs to that course's repo, which is what
`docs/course-release.md` says: *"The contract belongs in the course
repository."* My grep was of the tlda tree, and **a grep of the wrong tree
returns a true zero about a file sitting on disk.**

**And "no caller" is true but not a defect.** `docs/course-release.md`
documents it as a command a person runs — `plan`, then `stage`, then `deploy`.
It is a runbook verb, so having no programmatic caller is what that design
looks like rather than evidence of dead wiring. This is the opposite of the
promote endpoint, which had no caller of *any* kind and no runbook naming it.

**This is the same error as the one in §2**, where I reported a deployed secret
as "set nowhere" after grepping a repository for something that lives in `fly
secrets`. Two in one session, same shape: **the scope of the search was wrong,
and a zero from the wrong scope is indistinguishable from a zero from the right
one.** Establish where the thing would live before believing it is absent.

**What is actually established about that path:** mechanism present, contract
present and current, and no record of it being run against `pic`. That points
the published-site gap at *nobody invoked it*, not at an unfinished mechanism.
Whether it has ever run anywhere would show as a populated `releaseRoot`;
`class-build-pm` owns that path and has not claimed either way, and I have not
looked, because it is theirs.
