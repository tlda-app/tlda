# Fleet Chat Artifact Contract

Date: 2026-06-18

This is the code-grounded contract for sharing local artifacts through fleet chat.
It is the detailed companion to the short rule in `CLAUDE.md`.

## Contract

Local file paths in fleet chat are not evidence by themselves. A local path
mentioned in a normal `chat()` message is supposed to enter the attachment
pipeline: resolve the path on the sender's machine, upload the bytes to the fleet
server, replace the text with an attachment token, store the attachment metadata,
and render it as either an inline image or a file chip in the browser.

The user-visible browser result is the contract:

- Images, including screenshots, should render inline in fleet chat.
- Non-image files should render as attachment chips with server-visible URLs.
- Missing local files should block the send path or render a clear broken
  attachment, not become a silent dead link.
- A bare path such as `/tmp/foo.png` or a manually constructed
  `/api/file?path=/tmp/foo.png` URL is not acceptable proof unless that exact file
  already exists on the fleet server and the browser-visible URL has been
  verified.
- DB rows, local logs, DOM counts, and local filesystem checks are diagnostics
  only. They do not prove a user-visible UI failure is fixed unless a browser
  check shows the behavior the user needs.

## Intended Send Paths

### Normal MCP `chat()`

`mcp-server/fleet-tools.mjs` resolves an inline chat body, then calls
`processMessageText(message, agentCwd, TLDA_FLEET_SERVER)` before sending the
event. This is the main artifact path for agents. `TLDA_FLEET_SERVER` matters:
uploads target the fleet/event server where chat is viewed, not the document
server.

`shared/message-processing.mjs` detects local paths and localhost
`/api/file?path=...` image links, skips backticked code spans and fenced blocks,
resolves paths relative to the sender's cwd, uploads existing files, and returns
`{ resolvedMessage, inlineAttachments, brokenPaths }`.

If `brokenPaths` is non-empty, `chat()` refuses to send the message. If files
upload successfully, the stored chat event contains `metadata.inline_attachments`,
and the message text contains `{{att:N}}` placeholders.

### Shared Markdown File Messages

When `chat()` is called with `file` plus `section`,
`bundleSharedMarkdownImages()` uploads local image dependencies referenced by
that markdown and rewrites image URLs to fleet-server URLs. This is for image
includes inside the shared markdown content, not for chipifying every path in the
prose.

### Browser Upload And Drag-Drop

`POST /api/upload` accepts either raw bytes with `x-filename` or multipart
`file`. It writes the file into the fleet server upload directory and returns
`{ name, path, url }`, where `url` is
`/api/file?path=<server-side-upload-path>`.

### Unquote Path

`POST /api/unquote-file` is a second-tier repair path. When a previously
backticked path is unquoted, the server asks the sender's daemon to run the same
`processMessageText()` pipeline on the sender's machine, patches the stored
event, merges `inline_attachments`, and broadcasts an `event-update`.

## Intended Render Paths

`src/fleet/fleet-data.mjs` reads event metadata and maps
`metadata.inline_attachments` to `msg._inlineAttachments`.

`src/fleet/chat-render.mjs` expands `{{att:N}}` markers. Image attachments become
`<img class="chat-image" src="...">`; non-images become draggable `.ref-chip`
file chips with `data-url`.

Markdown links to `/api/file?path=...` are also converted during rendering:
image URLs become inline images, and non-images become chips. This is a render
convenience, not the cross-machine upload contract. It only works if the URL
points to a file on the fleet server.

`src/fleet/chat-image-retry.mjs` retries failed `/api/file` or `/api/files`
images with a cache-busting query parameter. This covers a race where a freshly
uploaded file is not readable at first paint; it does not make sender-local files
visible to the server.

## What `/api/file` Means

`GET /api/file?path=...` calls `res.sendFile(filePath)` on the server process.
The path is interpreted on the server filesystem. It is not an RPC to the
sender's machine, not an upload, and not proof that a sender-local file can be
viewed from the browser.

Therefore:

- `/api/file?path=/tmp/fleet-uploads/foo.png` is valid after `/api/upload` wrote
  that file on the fleet server.
- `/api/file?path=/tmp/some-agent-output.png` is usually invalid in multi-machine
  deployment unless that path is also present on the fleet server.
- If a report has only a local path, resend through `chat()` as a bare,
  non-backticked path or explicitly upload through `/api/upload` and verify the
  returned URL.

## Backticks Matter

Backticked local paths are treated as literal code and intentionally skipped by
attachment detection. This means:

- `Artifact: /tmp/foo.png` should upload `/tmp/foo.png`.
- ``Artifact: `/tmp/foo.png` `` should stay literal and should not upload.

Use backticks only when the path is prose/code, not when the file is the artifact
the user needs to see.

## Recent Failure Mode

On 2026-06-18 around 6:55 PM, `todo-rollout-manager` reported Playwright
verification for activity cards and gave this artifact as proof:

```text
/tmp/tlda-smoke/activity-card-element-live.png
```

That message put the path in backticks and did not include it as a bare path or
markdown image. Because `detectAttachments()` intentionally skips backticked
spans, the path never entered the upload pipeline. The message reached the user
as an agent-local filesystem path, not as a server-visible artifact.

The follow-up check manually constructed:

```text
https://tlda-fly.cormorant-matrix.ts.net/api/file?path=/tmp/tlda-smoke/activity-card-element-live.png
```

That failed because `/api/file` serves files on the fleet server, and the
screenshot was on the agent's local machine. The correct behavior would have
been one of:

- send a normal `chat()` message containing the screenshot path as an unquoted
  path so the attachment pipeline uploads it, or
- upload it with `POST /api/upload`, verify the returned `/api/file?...` URL
  gives `200` with `image/png`, then send that verified URL or inline image.

The user's correction was about intent: local paths in fleet chat are supposed to
get uploaded. Treating the broken link as "expected because local paths are
local" was wrong; it described the failure after bypassing the intended chat
path, not the contract.

## Tests To Keep

`test/message-processing-artifacts.test.mjs` covers:

- bare local image paths become `{{att:0}}` and upload;
- missing bare local paths are marked broken;
- backticked local paths remain literal and do not upload.

Future browser-visible tests should also prove that a local screenshot path sent
via chat renders as `img.chat-image` in a mounted fleet chat panel.
