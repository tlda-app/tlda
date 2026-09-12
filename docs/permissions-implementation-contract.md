# Permissions Implementation Contract

Source pointers:

- Fleet chat `permissions-canon-reader` → `stabilizer`, 2026-07-16
  14:04:14 EDT, message `1349001` (full canon).
- Fleet chat `stabilizer` → `permissions-canon-reader`, 2026-07-16
  14:05:34 EDT (acceptance).
- Fleet chat Skip correction, 2026-07-16, message `1350116` (printer
  authority).
- Fleet chat chief correction, 2026-07-16, message `1350129` (printer
  authority).
- Local transcription: `scratch/skip-permissions-canon.md`.

This contract resolves the canon's open local intersection question. It does
not settle the deferred cross-box mapping schema.

## Objects

There are four distinct objects:

1. A **permission profile** is a configured YAML name whose definition gives
   separate unions of named read regions and named write regions.
2. A **permission request** asks for one configured profile.
3. A **permission grant** is the daemon's resolved result. It is either:
   - one configured profile; or
   - a real intersection of configured profiles produced by an actual clamp.
4. A **permission set** is compiled enforcement data: concrete read and write
   paths derived from the grant. It is not an identity and must not be used to
   manufacture one after the fact.

Unknown profile names refuse at the boundary. Request and grant are distinct;
synonymous request/grant fields are forbidden.

## Resolution and persistence

- The destination daemon owns resolution and enforcement.
- The server forwards the request and agent identity; it grants nothing.
- Resolution returns the permission grant as part of the decision. Code must
  not recover a grant identity later by comparing expanded path sets.
- A single-profile result persists that configured profile name.
- A real intersection persists a structured intersection whose operands are
  the configured profile names that were actually intersected, together with
  the separately compiled read and write permission sets and provenance.
- An intersection is not a NULL profile, an anonymous grant, or a new profile
  name. Code must not coin a word such as `cwd`, `scope`, `policy`, or
  `unmatched` to stand for it.
- A result that is neither a configured profile nor a structured intersection
  of configured profiles refuses before launch or persistence.
- Durable wake restores the persisted grant and recipe. The caller's cwd,
  profile, or process context cannot replace them, and no-flag wake does not
  rewrite the grant.

## Human- and agent-visible output

Printing permission detail is optional and observational. The printer may omit
the line when it cannot produce one of the legal coherent forms below. If
printed, it must name a complete real object using Skip's vocabulary:

- a configured profile name, for example `permissions: wd`;
- an honest intersection of configured profile names, for example
  `permissions: wd intersection math`; or
- the full regions, with **read regions and write regions printed separately**,
  using the configured region names or complete path descriptions.

Forbidden output includes `scope`, `CWD scope`, `fenced (cwd)`, `unfenced`,
`full access`, `unmatched`, `anonymous CWD`, and any other agent-minted label
that does not completely identify the configured profile, real intersection,
or separate read/write regions.

Printer, formatter, and logging code must never validate, reject, mutate, or
gate a grant or runtime launch. Semantic invalidity and refusal are decided by
resolution and enforcement upstream, independently of display.

## Required invariants

- Every configured profile includes the basic-usability region needed for
  fleet communication.
- When Skip requests a grant, implement the grant directly. Do not substitute
  a workaround, fallback store, compatibility path, sandbox bypass dance, or
  retained implementer restriction.
- Permission-to-spawn is separate from permissions-at-spawn and remains tied
  to the agent's local daemon/box grant.
- Sessions ordinarily run with their agent's durable grant; mismatched session
  permissions are not an accepted normal state.
- Cross-box mapping remains destination-daemon-owned. No server-owned global
  permission policy may be introduced while its exact schema is deferred.

## Review gate

Reject a change if it:

- introduces a synonym or fallback for request, grant, profile, or region;
- derives identity from a compiled permission set;
- persists NULL/anonymous state instead of a real structured grant;
- prints invented permission vocabulary;
- combines read and write regions into one ambiguous label;
- lets an unknown profile fall back or launch;
- lets caller context override a durable wake recipe; or
- solves a requested permission by workaround instead of granting it.
