# Source Ownership Manifest Transaction

Status: architecture contract for the accepted source ownership design under
review. It is grounded in live main `0edbc31733cf97015b971e7cf23d98afa3e254f6`
and the corrected design reviewed around held implementation candidate
`f85640dc7f14c6024e44bbad79066099dea10046`.

`f85640dc` is held for review. This document does not say that implementation is
shipped, deployed, or live.

## Problem

The product invariant is stronger than file ownership bookkeeping: tlda does
not add silent ancillary source files. It mirrors, classifies, validates, and
builds authored source supplied by an authoring surface; it does not invent
paper source content. An explicit project-initialization command may create the
requested main document as that operation's declared authored source.

The server project source tree can still contain paths with different authority.
Some paths are authored source supplied by a client authoring surface. Other
paths exist in the same tree but are outside the authored ownership set: build
byproducts, legitimate project/build state, and tlda-maintained scratch/template
machinery that supports rendering or review without becoming paper source.

Live main does not persist the distinction. Its source list and source hashes are
derived by walking the project source tree and filtering a short junk-extension
set. That makes deletion and hash comparison depend on what happens to be on
disk, so a client sync can accidentally claim or delete a file it never authored.

The accepted design is a complete-manifest transaction. Every source-writing
caller declares the complete set of client-owned authored source paths that
should exist after the transaction. Ownership comes only from a successful
complete declaration, and tlda must not create extra source paths outside that
declaration.

## Core Objects

The owned authored source set is the persisted set of project-relative paths
currently owned by external authoring input: CLI push, CLI watch, daemon source
watch, browser source edit, browser-created markdown source, or Overleaf git
sync.

Everything outside the owned set is not owned source for synchronization
purposes, even if it lives under `server/projects/{name}/source/` and even if
its filename looks like source.

The source manifest is the complete declaration sent with a source transaction.
After validation, it replaces the persisted owned authored source set.

The source context is the project format and main file. Classification is
contextual. For example, `README.md` is ordinary owned authored source for a
markdown project whose successful manifest declares it. In a LaTeX project,
tlda-seeded `README.md` source placeholders are inappropriate legacy behavior
being removed; the replacement invariant is that LaTeX init creates and declares
exactly its requested main file, not an ancillary README.

## Invariants

1. Ownership is explicit and transactional. A path becomes owned only when a
   complete manifest containing that path commits successfully.
2. Tlda does not add silent ancillary source files. Explicit initialization may
   create the requested main document as declared authored source; project/build
   tools may create legitimate project state. Tlda otherwise mirrors and
   classifies authored source rather than inventing content.
3. The new manifest equals the complete set of client-authored paths that will
   exist after applying writes and deletes to the prior owned unchanged paths.
4. Validation covers every declared manifest path and the proposed post-
   transaction owned tree, not only files changed in this request.
5. Before any mutation, reject absolute paths, traversal, invalid source paths,
   non-authored paths, declared paths that would not exist after the transaction,
   and surviving owned files omitted from the declared manifest.
6. A pushed file must be present in the manifest. A deleted file must be absent
   from the manifest.
7. Deletion is limited to paths already in the owned set. A request cannot delete
   a path outside ownership.
8. Listing and hashing source for incremental sync use only the owned set, after
   contextual source classification.
9. Paths outside ownership are invisible to ownership equality. Build byproducts
   and tlda-maintained scratch/template state are not backfilled into ownership
   because they exist on disk.
10. The transaction is all-or-nothing: if validation, file IO, Overleaf push, or
   metadata commit fails, no partial ownership change is committed.

## Transaction Sequence

All source-writing paths enter the same project push operation:

1. Load the project record and current owned authored source set.
2. Normalize the caller's declared manifest using the current source context.
3. Build the proposed owned tree:
   - start with prior owned paths not listed for deletion;
   - add or replace every pushed file path;
   - remove every declared deletion path.
4. Validate the complete declared manifest and the proposed owned tree before
   writing:
   - every manifest, write, and delete path is project-relative and contained in
     the source root;
   - every manifest path is classified as authored source in this context;
   - every pushed path is included in the manifest;
   - every deleted path is excluded from the manifest;
   - every manifest path will exist after the transaction;
   - every surviving owned path is still declared.
5. Create a durable, credential-free recovery snapshot and atomically publish
   its journal under the project before mutating live source, metadata, or the
   clone. Durability means fsyncing every snapshot file and directory, the
   temporary journal, the renamed journal, and both enclosing directories
   before the operation crosses into live mutation. For linked projects,
   snapshot clone worktree bytes but never `.git` or its credential-bearing
   config.
6. If the project is linked to Overleaf and this is not an Overleaf-originated
   pull, fetch the remote and prepare the same writes/deletes as a local clone
   commit without publishing it.
7. Write changed file contents, delete only owned paths requested for deletion,
   and commit project metadata including the new owned authored source set.
8. Publish the prepared Overleaf commit as the final fallible transaction step.
   No local filesystem or metadata commit follows successful publication.
9. Immediately remove the successful transaction's journal and snapshot. A
   crash between publish and cleanup may leave recovery state. On startup or
   before the next transaction, reconcile it against the remote history: the
   proposed commit or any descendant proves publication succeeded; the prior
   head proves it did not; an unrelated third-party head requires explicit
   recovery without overwriting either side. Incomplete atomic-journal staging
   is cleaned without touching live state. Poll pulls and client pushes share
   the same per-project serialization boundary. A rejected pull transaction
   resets the clone to its pre-fetch head and records an error, so the same
   remote head is retried on the next poll rather than being mistaken for an
   already-applied update. Incomplete transaction directories are safe to
   remove because live mutation cannot begin first.
10. Refresh materialized parts, dispatch the build decision, and broadcast the
   existing source-change signal as today.

Member-only book updates are not source mutations. They may continue to update
book membership without a source manifest because they do not claim, write, or
delete authored source.

Poll-driven Overleaf pulls and request-driven pushes share the same per-project
serialization boundary, so neither may mutate the clone or source tree while
the other transaction is in flight.

## Caller Inventory

Every source-writing caller must supply a complete manifest for the state it is
declaring, not just the files it changed.

- CLI `doc push` / incremental push: fetch project context, hash the local owned
  candidate tree, diff against server hashes, send changed files, deleted owned
  files, and the complete local manifest.
- CLI `watch`: on initial push, send all collected source files and the complete
  manifest; on each debounced change, recompute the local manifest and send it
  with changed/deleted paths.
- Fleet daemon source watcher: on connect/bootstrap, send watched source files
  and the manifest for the watched authored graph; on file changes, rescan newly
  discovered TeX or markdown dependencies, then send `source-change` with the
  complete manifest.
- Server daemon bridge: `source-change` is only transport. It forwards
  `files`, `deletedFiles`, `sourceManifest`, and attribution into the shared
  project push transaction.
- Browser source editor `PUT /source/:file`: fetch current project/source-file
  inventory, add the edited path to that inventory, and send the resulting
  manifest with the file write. The server route must use the caller's manifest;
  it must not synthesize ownership from server state.
- Browser-created markdown surfaces: TOC scratch pages, temporary markdown
  pages, and math-note markdown sync all create a manifest from the files they
  author, normally a single markdown main file.
- MCP report sharing: the `report()` tool may create a markdown report project
  such as `report-<task-id>` and push the report markdown file. That report file
  is the operation's declared authored source, and the push must carry the
  complete manifest for that report project.
- MCP `push`: local MCP file pushes are authoring ingress, not an escape hatch.
  The tool reads caller-provided content or local paths, sends those files
  through the same project push transaction, and must declare the complete
  authored set that will exist after the push.
- Overleaf link and pull sync: the git clone's tracked files, excluding explicit
  git control paths, are the complete authored set. Initial sync, later pulls,
  and clone-to-project reconciliation send that tracked set as the manifest.
- Overleaf push after tlda-side edits: uses the same transaction boundary; if the
  upstream push fails, the source transaction fails rather than recording local-
  only ownership.
- CLI `init`, `create`, and `link`: after creating project metadata, the first
  source upload sends a manifest for exactly the authored files supplied by the
  caller. An explicit init command may create the requested main document as the
  operation's declared authored source. These flows must not invent extra
  ancillary source files.
- CLI `move`: recreates the project on the target server, uploads collected
  source files, and declares the moved project's complete authored set.
- CLI `scratch`: a lightweight markdown scratch document declares its markdown
  file as the owned authored set for that scratch project.

## Contextual Classification

Source classification is not a filename-only rule.

- SVG/LaTeX projects allow TeX sources, bibliographies, style/class files, TeX
  extras, and figure assets.
- Markdown projects allow the markdown main file and its referenced assets.
- HTML and slides projects own their authored artifact set as declared by their
  collector.
- `README.md` is owned only when the source context and successful manifest say
  it is owned. Markdown `README.md` is ordinary authored source when declared by
  a markdown project. LaTeX `README.md` seeding by tlda is inappropriate legacy
  behavior being removed, not an ownership special case to preserve. LaTeX init
  creates and declares exactly the requested main file.
- Compound build junk must be filtered as a path/suffix rule, not by taking only
  the last extension. Examples include `main.synctex.gz`, `main.fdb_latexmk`,
  `main.run.xml`, and `_fmt.` intermediates.
- Ignored source directories such as `.git`, `node_modules`, and generated site
  output do not become owned through directory walking.

## Failure And Atomicity

Validation happens before writes, deletes, Overleaf sync, or metadata updates.
The project must remain byte-for-byte and metadata-for-metadata unchanged after
a rejected transaction.

Overleaf is part of the transaction when enabled. A failed git commit, merge,
push, or conflict blocks the tlda source mutation from committing ownership. A
conflict may expose conflict files for review, but it does not silently bless a
new owned set.

The manifest update is not a cleanup step. It is part of the local commit. If
file mutation succeeds but ownership persistence fails, the snapshot is
restored and the transaction must not be reported as accepted. A remote
compensation uses force-with-lease: if another author advances the remote, tlda
must not overwrite that work or pretend rollback succeeded. It retains a
durable credential-free recovery record and reports `recovery-required` using
a server-visible identifier rather than a host filesystem path.

## Examples

A LaTeX init command requests `main.tex`. The operation may create `main.tex`
and must declare manifest `["main.tex"]`. It does not add `README.md`; any
legacy initializer that did so is being removed. The owned set remains exactly
`main.tex`.

A markdown project has `mainFile: "README.md"` and the client declares
`["README.md"]` in a successful transaction. The same filename is now owned
authored source because the context and declaration make it so.

An incremental push edits `sections/intro.tex` and leaves `main.tex` unchanged.
The manifest must include both paths if both remain owned. Sending only the
changed path is invalid because it would omit a surviving owned file.

An Overleaf pull deletes `old.tex`, adds `new.tex`, and leaves `main.tex`
tracked. The transaction sends changed files for `new.tex`, `deletedFiles:
["old.tex"]`, and a manifest containing `main.tex` and `new.tex`.

A build creates `main.aux`, `main.synctex.gz`, and `main.run.xml`. None of those
paths enter ownership merely because they are in the source tree.

## Non-Goals

- No backfill from the current source tree into ownership.
- No compatibility mode that accepts source writes without a manifest.
- No dual semantics where some callers declare full ownership and other callers
  send only deltas.
- No local fallback for daemon or Overleaf paths when the owning surface cannot
  provide the complete declaration.
- No special deletion APIs outside the shared source transaction.
- No reliance on filenames, extensions, or machine identity to infer ownership.
- No tlda-created LaTeX README/source placeholder or other silent ancillary
  source scaffolding.

## Testing Obligations

Tests for this contract must cover both behavior and caller wiring.

- Missing manifest on any source write is rejected before mutation.
- A manifest missing a pushed file is rejected before mutation.
- A manifest containing a deleted file is rejected before mutation.
- A manifest omitting a surviving owned file is rejected before mutation.
- Traversal, absolute, invalid, non-authored, and nonexistent declared paths are
  rejected before mutation.
- Deleting a path outside the owned set leaves that file intact.
- CLI initialization/link/create flows may create the explicitly requested main
  document as declared authored source, and do not add a LaTeX README/source
  placeholder or other silent ancillary source scaffolding.
- `README.md` is owned for a markdown-main case after a successful declaration.
- Compound build junk such as `main.synctex.gz`, `main.run.xml`, and
  `main.fdb_latexmk` is excluded from owned hashes and manifests.
- `hashSourceFiles` and `listSourceFiles` return only owned authored source.
- CLI push/watch, daemon source-change, browser PUT, browser markdown creation,
  MCP report sharing, MCP `push`, Overleaf sync, init/create/link/move, and
  scratch creation each pass a complete manifest into the transaction.
- Rejected transactions preserve project metadata, file contents, and ownership
  exactly.
