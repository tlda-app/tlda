# Settings controls: how they go dead, and how to check

A settings control that writes a value nobody reads is worse than a missing
setting. Skip changes it, nothing happens, and the conclusion available to him is
that the app is broken — see `AGENTS.md` §"He designs. He does not read the code
either". This file is the standing check against that, and the four ways it has
actually happened here.

An audit on 2026-08-12 found **8 of 45 controls in the settings panel inert**.
The inventory itself was a point-in-time disposition and is deliberately not
reproduced here; what follows is the part that stays true.

## Four routes to an inert control

Only the first is found by grepping the pref key.

**1. A revert removes the feature and leaves its control behind.** Twice,
independently:

- `12351a0b5` "Revert corner rail slider controls" deleted `CornerRailSlider.tsx`,
  its CSS, and 857 lines across six files — and never touched `PrefsTab.tsx`.
- `1b67e27e9` "Delete obsolete slide navigation mode" removed the reader; 53
  seconds later `6f167e1df` "Keep slide preference surface unchanged" restored
  the control, touching only `PrefsTab.tsx` and `preferences.ts`.

The tell is a diffstat that deletes a feature's implementation files with the
settings file absent from the list. **A revert is not done until the control goes
too.**

**2. A per-shape model supersedes a global pref, and the pref survives.**
`docview-sources` lost to the docview shape's own `sources` prop; the pref stayed,
unreachable, as a second source of truth. The tell is a pref whose name matches a
shape prop.

**3. Born inert.** `bot-model` had no reader in any commit — `git log -S` returned
only `PrefsTab`. This one is convincing because `useAvailableSpawnModels` filled
it with real model names, so it looked live.

**4. Wired to a CSS variable nobody consumes.** `readabilityStyleVars` emitted
`--fleet-line-height` and no stylesheet asked for it, while `--fleet-base-font`
sat one line below with 224 consumers. **Nothing in the code looks wrong**, and no
search for the pref key can find it.

## The standing checks

### Pref keys with no reader

```sh
for k in $(grep -o "^  '[a-z-]*'" src/preferences.ts | tr -d " '"); do
  n=$(git grep -c "$k" -- src server shared bin \
        ':!src/preferences.ts' ':!src/panels/PrefsTab.tsx' 2>/dev/null | wc -l)
  [ "$n" = 0 ] && echo "NO READER: $k"
done
```

**This produces candidates, not defects.** Run as of 2026-08-12 it flagged 14 keys
and none was a defect. **A check that cries wolf gets ignored, so the triage is
part of the check.** Three reasons a flag is fine:

- **The panel is its own consumer** — `known-devices`, `device-names`,
  `prefs-open-sections` are read by `PrefsTab`, which the command excludes.
  Re-grep without the exclusion.
- **The reader is outside this repo.** Bot prefs are read in
  `~/work/tlda-bots/*/`. **Always grep the bot working copies before calling a bot
  pref dead.** `bot-self-check-enabled` (live) and `bot-model` (dead) are
  indistinguishable from inside this repo, and a reader-search that stops at the
  repo boundary reports a live control as dead.
- **Dead but not a control** — a key read into state and rendered by nothing costs
  nobody anything. It is why this list is not a bug list.

### CSS variables with no consumer

Route 4 is invisible to everything above, so check the emitter's output directly —
every property `readabilityStyleVars` returns in `src/readabilityProfile.ts`:

```sh
git grep -c "var(--fleet-line-height" -- src
```

**Re-establish "no zero left" after anyone touches that emitter.** As of
2026-08-12: base-font 224, line-height 7, touch-target 5, chrome-alpha 14,
content-alpha 7.

### Where the default actually lives, which is none of the places you just checked

The checks above find a control nothing reads. **They cannot find a control that is
read correctly and whose default comes from somewhere else**, and that is a
different failure with the same symptom: you change a default, ship it, and nobody
sees a change.

**`getPref` has no absent state.**

```js
export function getPref<K extends PrefKey>(key: K): (typeof DEFAULTS)[K] {
  return (key in _cache ? _cache[key] : DEFAULTS[key]) as (typeof DEFAULTS)[K]
}
```

Unset falls back to `DEFAULTS` in `src/preferences.ts`. **So that is where a
default lives.** A `*_DEFAULT` constant next to the component and a `var(--x, 60px)`
CSS fallback both look like the default and are both shadowed by it.

**And the trap on top: a presence check against `getPref` is a no-op that reads as a
fix.** On 2026-08-18 the TOC hover zone needed raising. `ZONE_WIDTH_DEFAULT` in
`TocTab.tsx` went up; `getZoneWidth()` compared the pref to that constant, so it
could not tell "unset" from "set to the default" and fell through to a legacy
`localStorage` key. That comparison was replaced with a presence check —

```js
const raw = getPref('toc-hover-zone-width')
if (raw !== undefined && …) return normalizeZoneWidth(raw)   // always taken
```

— which **always takes the first branch**, because `getPref` returns `DEFAULTS`
rather than `undefined`. `preferences.ts` held `60`. So the constant was raised,
the CSS fallback was raised, the fall-through was "fixed", and the zone stayed
60px. Three changes, each verified, each shadowed by a fourth file nobody opened.

**The check, and it is one line:**

```sh
grep -n "'<pref-key>'" src/preferences.ts
```

**If the key is in `DEFAULTS`, that number is the default and everything else is
decoration.** Change it there, and delete the shadowing constant or make it read
from the pref rather than sit beside it.

**The general form, because this is what made it survive three passes of the checks
above:** *"I verified the control is wired"* is not the same as *"I found where the
default lives"*, and from inside your own verification there is nothing that
distinguishes them — a wired control with a shadowed default passes every check on
this page. Ask the second question explicitly.

## Two traps when making an inert control real

**Wiring a control changes what people see, even when no default changes.** The
stored default was always there; it just never applied. Say which of the two you
are doing.

**Check the stored values first, and check the right store.** `readability-profiles`
is server-backed in the `fleet_prefs` table, not `localStorage` — a `localStorage`
read cannot distinguish "no stored value" from "wrong place to look", and reporting
the second as the first is an assertion about code Skip cannot check. Read it off
the box that serves him:

```sh
flyctl ssh console -a tldraw-sync-skip -C "node -e \"…fleet_prefs…\""
```

**Prefer a wiring that is invisible at the default.** `--fleet-line-height` was
safe to introduce because the seven prose surfaces already declared `1.5` and the
profile default *is* `1.5`, so nothing moved until the number moved. Where that is
impossible, say the exact delta: making the touch target real took a coarse-pointer
agents row from 24px to 28px.
