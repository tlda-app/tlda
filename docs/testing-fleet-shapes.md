# Testing fleet surfaces (chat, inbox, agents, docview, mdchip) — READ THIS FIRST

If you are about to browser-test chat, the inbox, the agents/roster panel, the
doc-view panel, or the markdown chip, and you find yourself writing
"chat doesn't show" / "the log is hidden" / "the chip never mounts" — **stop.**
Nine times out of ten that is your test rig, not the product. This guide tells
you how to set the rig up so the surface actually mounts, and how to tell a rig
artifact apart from a real bug.

## The one fact you need

Chat and the other fleet panels are **per-device fleet shapes**:

```
fleet-chat, fleet-agents, fleet-search, fleet-docview,
fleet-source-editor, fleet-inbox, fleet-touch-inbox, fleet-notifications
```

(`FLEET_SHAPE_TYPES` in `src/shapes/fleet-utils.ts`.) The markdown chip lives
**inside** the chat surface, so it inherits all of this.

A fleet shape is **yours** — and therefore renders for you — only when:

```
shape.props.userId   === getHumanId()     // your identity, e.g. fleet:tester
shape.props.deviceId === getDeviceId()    // this browser's device id
```

(`isMyFleetShape` in `src/shapes/fleet-utils.ts` — single source of truth.)

These shapes do not exist in a room by default. They are created by a **fleet
layout** (`createFleetLayout` / `createFleetLayoutDetailed`), triggered from the
UI by the **fleet icon pill** (`FleetIconPill`).

## Identity and device are AUTOMATIC — never your job, never "missing"

You do **not** set up an identity or a device. The app does it for you:

- **Identity auto-creates.** When no identity is stored, `IdentityPicker`
  (mounted in `App.tsx`) auto-registers a **temporary "joke" identity** via
  `temporaryName()` — you'll see *"Using temporary identity X. Switch identity in
  Settings > Preferences."* That's a real `fleet:<name>` you could rename later.
- **Device auto-mints.** `initDeviceId()` runs on page load, generates a stable
  per-browser device id, and persists it (localStorage + IndexedDB).

So **`identity-missing` and `device-missing` should be impossible in a real
session.** If `createFleetLayout` ever returns one of those, or `getHumanId()` /
`getDeviceId()` is empty, that is a **bug — report it to chiefo.** It is NOT a
setup step you skipped, and it is NOT something to work around by changing
product code. (Likely real causes worth reporting: your page mounted a route
*without* `IdentityPicker`, or you called `createFleetLayout` before the
auto-identify finished — wait for it.)

## The one real setup step: create a layout, then wait for it to render

1. **Create a fleet layout.** Click the fleet icon pill and pick a preset (this
   calls `createFleetLayoutDetailed`). This is what mounts `fleet-chat` et al.
   **owned by you.** Confirm the result is a real layout, not an error reason.
2. **Wait for it to actually render.** Poll until your `fleet-chat` shape exists
   AND its content is visible (e.g. `.fleet-chat-log` is present and
   `getComputedStyle(...).visibility !== 'hidden'`), not just until the DOM node
   appears. Screenshotting before the layout finishes mounting gives you the
   blank/hidden frame and a false "broken" verdict.
3. **Now run your test** against that visible surface.

## Diagnosis rule — before you ever write "X is broken"

When a fleet surface is absent, blank, or computes `visibility:hidden`:

1. **Did you create a layout?** No layout ⇒ no `fleet-chat` shape ⇒ nothing to
   see. This is the step testers actually skip. Create one and wait for it.
2. **Are `getHumanId()` and `getDeviceId()` populated?** They should be, always.
   If either is empty, the auto-identity/auto-device path is broken — **report
   that as a bug**, don't try to "set up" an identity yourself.
3. Only if a layout exists, identity+device are populated, and the surface is
   still wrong do you have a candidate real bug — compare against the base branch
   in the same rig to confirm it's a regression in your change, not pre-existing.

## Hard rules

- **Never test in a doc Skip is viewing** (e.g. `balancing-act`, `bregman`).
  Clone a real doc to a fresh throwaway name and test there. Taking his live
  session out from under him is disabling, not a minor annoyance.
- **Never change product code (especially chat or identity) to make a rig
  "work."** If chat is invisible because you have no layout, the fix is your
  rig. If identity is missing, that's a bug to report — not code to patch around.
- **Clean up after yourself.** Remove every test layout, shape, anchor, and test
  identity you created from the room before you leave. Persisted junk makes real
  review sessions look like multiple layouts are fighting.
- **If you can't get the rig right, route it to the `app-tester` agent.** That
  agent exists precisely so fleet-surface tests are run by someone who knows the
  layout setup. Don't flail at the harness and don't guess.

See also: `AGENTS.md` → "Fleet Shape Ownership & Junk Identities" and
"Playwright Coordination".
