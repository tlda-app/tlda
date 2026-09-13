# Muse Code adapter: native Meta authentication

The experimental adapter runs the native Muse Code CLI with Muse-owned tools,
sessions, permissions, subagents, and worktrees. It does not run Muse as a Goose
provider. Its launcher registry entry is present, but `buildCmd` still rejects
fleet identities while the integration is gated. Fleet login, inbox, skill
recognition, and notification/lifecycle verification remain release gates.

## Installation and configuration

The official installation command is:

```sh
curl -fsSL https://dev.meta.ai/install.sh | bash
muse --version
muse --help
muse exec --help
muse resume --help
muse login
```

Characterization used Muse Code **1.1.1 (1.1.1-R2514.1)**. Recheck the installed
help before using a different release. The official documentation is at
[Meta's developer site](https://dev.meta.ai/docs/muse-code/configuration).

The [settings example](../config/muse/settings.json) selects the native Meta
provider and `muse-spark-1.3-contributor`. For usage billing, set
`META_API_KEY` in the deployment environment that starts the daemon; Muse gives
that key priority over account login. Consequently, any key present in the
daemon's login-shell environment selects usage billing for every Muse launch.
The adapter inherits the deployment key
without copying it into generated settings or accepting it in public daemon
configuration. Without a deployment key, Muse falls back to account
authentication from `muse login`; run login with the same `XDG_CONFIG_HOME` as
the launched process. The adapter does not map an OpenRouter credential or
configure a proxy. The fleet model default is unchanged.

Copy the example to a deployment-owned configuration root outside the repository,
under `muse/settings.json`, or use the user's existing native configuration.
Do not point a live Muse process at the repository's example directory: Muse
creates auth-store runtime files beside its settings. Do not overwrite existing
settings with the example. Native personal-context behavior is preserved unless the
operator explicitly selects `--no-foreign-personal-context` for a headless run.
Personal instructions and raw session exports do not belong in this repository.

## Adapter contract

[muse.mjs](../agent-launch/harness/muse.mjs) follows the existing function-based
adapter interface: `resolveModelSelection`, `resolveModel`, `resumeId`, and
`buildCmd`. It additionally exposes argument construction for direct native
execution. Model resolution uses the existing daemon model specification;
there is no separate model registry or provider implementation.

For direct execution, pass an explicit model, workspace, and prompt. Set
`headless: true` for `muse exec --json`. Permission switches come from
`harnessOptions.required` and `harnessOptions.preferences`, as individual argv
tokens; the adapter does not add `--yolo`, a sandbox override, or a personal-rule
policy. Configuration environment values belong in `harnessOptions.env`.
Credentials remain in the deployment environment or Muse's native auth store
outside the repository.

Fleet configuration preparation creates a per-agent settings directory under
the system temporary directory. Its TLDA stdio server receives the normal
launcher-provided fleet/mint identity and daemon route. The auth file is a
symlink to the configured native account store; credential contents are not
copied into settings. Native session data stays in Muse's existing data root.

The adapter preserves the bare native session UUID. Native TUI resume uses
`muse --model MODEL --workspace WORKSPACE resume UUID`. Exact caller-specified
IDs are supported by headless `--session-id` and MSP `session/start`; the
verified TUI help does not expose that flag. Headless resume is rejected because
`exec` has no verified resume option. No parallel transcript store is created.

## Native capability evidence

Except for the explicitly native Meta MCP result, these observations use the
real Contributor model through OpenRouter. Echo provider observations are not
used to certify model capabilities.

| Capability | Observed result |
| --- | --- |
| Headless execution | JSONL streaming followed by a completed terminal event |
| Workspace | Native workspace metadata and an actual edit in the selected disposable clone |
| Repository work | Read implementation and tests, add one regression test, run tests, inspect output and diff, finish |
| Exact identity | MSP accepted and returned the requested native UUID |
| Resume and history | A new MSP process resumed the same UUID, returned prior messages, and recalled a value absent from the new prompt |
| Cancellation | Cancelling an active model step produced a native cancelled terminal event |
| MCP | Current Muse with native Meta account auth completed a qualified deterministic plugin call; real fleet integration remains a separate gate |
| Tool choice | Direct provider controls returned HTTP 400 for `tool_choice: "required"`; the endpoint reports support only for `"auto"`, excluding `"none"`, `"required"`, and named function choices. A caller cannot force or forbid a tool call through this parameter. |
| Existing skills | The native user-scope catalog exposes the existing unmodified skills under `~/.agents/skills`; no translation is needed |
| TLDA skill gate | Not verified end to end; requires working native MCP |

The repository exercise used a remote-free disposable clone. It added one
26-line regression test. Baseline **3/3** tests became **4/4**, and an independent
rerun passed **4/4**. The implementation remained unchanged. This is one direct
native task, not the requested fleet benchmark suite or a comparison with
Claude/Codex.

MSP is Muse's native newline-delimited JSON-RPC interface (`muse serve`). Its
schema is available through `muse schema generate-json-schema`. Start/resume
command IDs are UUIDv7. An accepted turn or cancellation request is not terminal
proof; use the corresponding native completion notification. The adapter does
not add an MSP supervisor or duplicate Muse's internal agent lifecycle.

## MCP verification and release gate

Muse 1.1.1 with native Meta account authentication invoked
`mcp__plugin_control_control__measure` and returned the deterministic server's
measurement. The same plugin failed through the tested OpenRouter route on
1.1.1. Older 0.1.0 and 0.2.1 builds completed that call through OpenRouter;
tested 1.0.2 and 1.0.3 builds rejected the bare tool name. This bounds an
interoperability failure on that route, not a general inability to use MCP.
The raw provider-wire cause has not been established.

The release gate is an actual native TLDA login and inbox exchange followed by
skill-read recognition and notification/lifecycle verification. Until it passes,
the adapter rejects fleet launch requests. The representative
feature evaluation is blocked; a synthetic non-fleet run is not a substitute.

## Historical OpenRouter cost measurement

The following measurements describe the earlier OpenRouter Contributor route.
They do not measure the native Meta account/subscription route used by this
adapter. Native-route cost and successful fleet work per dollar remain unmeasured.

Muse's native export retains provider usage records by session and run. The
headless stream includes OpenRouter generation IDs, whose accounting records
provide native prompt, completion, and cached token counts plus the actual
charge. A known generation returned a nonzero charge; an invalid generation ID
returned HTTP 404. Account-wide credit deltas were not used.

At the observed rates, the arithmetic cross-check is:

```text
(native_prompt - native_cached) × $0.0000001
  + native_cached × $0.000000002
  + native_completion × $0.0000002
```

The six-generation repository task cost **$0.008515274**. The separate cold smoke
probe cost **$0.0048361** and is excluded from that task total. Cache reads were
observed on later task generations. These measurements support neither a
general per-turn extrapolation nor a conclusion about successful fleet work
per dollar; that comparison requires the blocked evaluation. No cost telemetry
subsystem is added.

## Guidance ingestion

In the measured repository run, a 112,109-byte project guidance file expanded
through escaping and combination with native context. The assembled rules
block was 149,392 bytes and the retained block was 65,536 bytes. A separately
labeled project-only control reduced assembled context to 115,055 bytes; the
project file alone still exceeded the retention limit.

Native exports verified both halves of that control: project guidance remained
present and the personal-rule wrapper was absent. The same instrument detected
the wrapper in the positive control. Future comparisons must use identical
repository inputs and record this ingestion difference as part of the native
harness-and-model package, not attribute it solely to model quality.

## Verification

```sh
node --test agent-launch/harness/muse.test.mjs
```

Retain raw native help, session traces, exports, and provider accounting outside
the repository. Before publishing, scan the exact diff for credentials, personal
context, account/session identifiers, and machine-specific paths. Public results
should contain the measured outcomes and reproducible method, not private logs.
