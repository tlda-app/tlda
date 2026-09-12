# Release readiness checklist

This checklist records the gates for publishing a tlda release. It is not a live
issue tracker or a deployment-status dashboard. Current work belongs in the
project's issue tracker; current deployment state must be checked directly.

## Product

- [ ] The release candidate has been used in the real application environment.
- [ ] User-visible changes have been exercised on their relevant surfaces.
- [ ] Supported document formats render and remain editable as documented.
- [ ] Source synchronization, history, annotations, and chat work together on a
      representative project.
- [ ] Accessibility and touch interactions have been checked on supported input
      devices.

## Verification

- [ ] Type checking and the relevant automated test suites pass.
- [ ] Each release check has been shown to fail when its target defect is
      introduced or simulated.
- [ ] Browser verification uses the real application, not a substitute page.
- [ ] Test projects contain no private conversations, identities, credentials,
      or unpublished work.
- [ ] Known limitations are stated precisely in the public documentation.

## Documentation

- [ ] The README explains what tlda is, how to install it, and where to begin.
- [ ] User documentation matches the released interface and commands.
- [ ] Developer documentation describes the current architecture and supported
      contribution workflow.
- [ ] Deployment examples use non-secret example values and describe the
      topology without exposing a real installation.
- [ ] Screenshots come from an isolated demonstration project and contain no
      private room, inbox, terminal, or identity data.
- [ ] Links and document navigation have been checked in their rendered form.

## Repository privacy

- [ ] The tracked tree contains no credentials, private hostnames, personal file
      paths, fleet identifiers, private message identifiers, or conversation
      transcripts.
- [ ] Example identities and endpoints use clearly fictional values.
- [ ] Generated archives and machine-local artifacts are excluded from release
      packaging.
- [ ] Repository history has been audited separately from the current tree.
- [ ] Before any history rewrite, a separate recoverable clone has been created
      and verified.
- [ ] Any history rewrite uses path-specific transformations and is independently
      reviewed before publication.

## Packaging and publication

- [ ] The release workflow packages only the intended source and artifacts.
- [ ] Release notes identify the candidate commit and describe user-visible
      changes without private operational context.
- [ ] The candidate diff contains only the reviewed files.
- [ ] The publication commit, tag, history rewrite, and push each have explicit
      authorization.
- [ ] The published repository and release page are checked after publication.
