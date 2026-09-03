# pic-preview provisioning — resumption point

**Tracked deliberately.** This is a resumption point, not a report: the surface is
provisioned but not yet booted, and the next person works *from* this. `scratch/`
is gitignored, so an untracked copy would not survive.

**As of** 2026-09-03 02:5x UTC. Branch `provision-pic-preview`, commit
`965a3a429`, cut from `main` `96ced8b73`. Nothing is deployed.

---

## What exists now

| thing | value | how established |
|---|---|---|
| fly app | **`pic-preview`** | `fly apps create pic-preview --org personal` |
| volume | `sync_data`, 10 GB, `sjc`, `vol_vgn6x27pll31zlz4` | `fly volumes create`; 10 GB and `sjc` match `pic` |
| tailnet name | **`pic-preview`**, unclaimed | `tailscale status` lists `pic` and no `pic-preview`. The query returned `pic`, so it is not an empty-because-broken result. |
| URL it will answer on | **`https://pic-preview.cormorant-matrix.ts.net`** | `TS_HOSTNAME` in `fly.pic-preview.toml`; inside the licensed domain |
| config | `fly.pic-preview.toml`, `config/deployments/pic-preview/` | committed in `965a3a429`; `fly config validate` exits 0 |
| secrets | **none set** | `fly secrets list -a pic-preview` is empty |

**No `tlda-` anywhere** — not the app name, not `TS_HOSTNAME`, not the URL. The
count of `tlda-pic` hits outside `scratch/` is unchanged at 10; this added none.

---

## The one blocker: `TS_AUTHKEY`

**It is the only secret this box needs, and it is a credential I cannot mint.**

With `tokenGating: false` (see below) there is no `TLDA_TOKEN_READ`/`TLDA_TOKEN_RW`
to set — `initAuth` in `server/lib/auth.mjs` returns before reading either.
`DEEPGRAM_API_KEY` belongs to the voice box. `FEELINGS_RCLONE_CONF_B64` is
optional and the entrypoint skips it when absent. `TLDA_ROOT_REDIRECT` is
documented optional in `config/environment-variables.md` and is unset here.

That leaves `TS_AUTHKEY`. A fresh volume carries no stored tailscale identity, so
the first boot has nothing to come up from. **Minting the key is done by Skip in
the Tailscale admin console** — that is the established path, not a guess: the
prior keys arrived that way, were handed over in chat, and were redacted from the
store afterwards. There is no tailnet API key on this machine (`~/.config/tailscale`
does not exist; nothing in the repo or the deploy tooling holds one).

**Without it the alternative is worse, not absent:** `tailscale up` with no authkey
prints a login URL into `fly logs` that a human must then visit, which is the same
human step with an extra hop and a window in which the box is up and unregistered.

---

## The link, and why it does not exist yet

**A tailnet name is claimed by a node at boot.** There is nothing to reserve in
advance, so `https://pic-preview.cormorant-matrix.ts.net` does not resolve until
the app has been deployed once and the entrypoint has run `tailscale up`.

**So producing the link requires one deploy, and that is the chief's push.** The
brief said not to deploy application code without coming back first; this is the
point of coming back. Everything upstream of that deploy is done.

Note the ordering: `TS_AUTHKEY` must be set **before** the first deploy, or the
first boot comes up unregistered.

---

## Why it is ungated, which is what makes it a *tailscale-auth* link

**`pic` is funnelled to the public internet, so its token gate is its application
boundary. This box is not funnelled.** No `TS_FUNNEL` means
`scripts/fly-entrypoint-live.sh` runs `tailscale serve` rather than `funnel`, so
only a device on the tailnet reaches it at all. That is what makes it invisible to
students, and it is also the authentication.

**There is no Tailscale-identity auth in this codebase** — `server/lib/auth.mjs`
knows the Authorization header, `?token=`, and the `tlda_token` cookie, and
nothing else. So with `tokenGating: true` every way in carries `?token=`, and a
token in a URL persists into the browser profile it is opened in. **A link with a
token on it is exactly what must never be handed to Skip.** Hence
`tokenGating: false`, which is how `live` — the box he works on — is already
configured.

**The consequence, stated rather than buried:** anyone on this tailnet gets RW here,
because `validateToken` answers `'rw'` when gating is off. That is correct for a
candidate no student can reach, and it is why **this box must never be funnelled.**
If `TS_FUNNEL` is ever set on it, `tokenGating` has to change in the same commit.
That warning is in the toml and in `server.yaml` beside the line it governs.

---

## The no-rebuild promotion property

**Half verified, half not, and the unverified half is the reason to come back.**

**The content half — verified in code, not from the doc.** `deployCourseRelease`
in `scripts/course-release-core.mjs` calls only `verifyManifest`, `readPointer`,
`pointerEqual`, `activateArtifact` and `restoreArtifact`. The only two build call
sites in that file, `runSpec(artifact.build, …)` at lines 383 and 415, are both
inside `stageCourseRelease`, which begins at line 358. **`deploy` cannot build.**

**The app half — designed, not demonstrated.** One image carries every
deployment's config under `config/deployments/`, and `TLDA_DEPLOYMENT` selects
which boots, so `pic-preview` and `pic` are the same image running two
configurations. Promotion is therefore `fly deploy --image <the digest already
validated on the candidate>`, which builds nothing.

**What I could not establish, and it is a real gap.** I enumerated the deployed
image of every app in the org: **not one runs another app's image.** Every deploy
here has built per app, so this promotion path has never been exercised on this
tailnet. What I did check is weaker than the claim — a registry manifest read for
`tlda-pic` and `tlda-pic-dev` returns HTTP 200 under the fly auth token, and
`tlda-talk-probe` runs a foreign image from `docker-hub-mirror.fly.io`, which
together show cross-repository image references work at the machine level. **They
do not show a fly-app-to-fly-app promotion, and I am not going to report a
mechanism as demonstrated on that.**

**The demonstration needs the deploy that is the chief's to make**, and it is
cheap once made: deploy the candidate by digest, then read `fly image show` on both
apps and compare — same digest on both, one build in the logs. Until then this
property is asserted, and the brief was explicit that asserting it is not enough.

---

## What was NOT touched

`pic` and `pic-dev` are untouched — no config, no secret, no deploy. The only
edits outside the new files are two lines: `server/routes/classroom-manifest-icon.test.mjs`
gained `'pic-preview'` to its deployment list, and `docs/environments.md` gained a
section for the tier.

**The icon test's counterfactual was run:** removing
`config/deployments/pic-preview/dist-overrides/tlda-mark.svg` makes it exit 1, and
restoring it makes it exit 0. It can go red on the case it exists to catch. All
five override files are byte-identical to `pic`'s, checked with `git hash-object`.

The three `dist-overrides` PNGs are **force-added** — `*.png` is gitignored at
`.gitignore:75`, so a plain `git add` of the directory dropped all three silently.

---

## Next action

**Owner: the chief.** In order:

1. Skip mints a tailscale auth key; `fly secrets set TS_AUTHKEY=… -a pic-preview`.
2. Land `provision-pic-preview` and deploy it once:
   `fly deploy -c fly.pic-preview.toml`.
3. Confirm the node registered as `pic-preview` — not `pic-preview-1`, which is
   what a name collision silently produces — and hand Skip
   `https://pic-preview.cormorant-matrix.ts.net` with no query string on it.
4. Then demonstrate the promotion property by digest, as above.
