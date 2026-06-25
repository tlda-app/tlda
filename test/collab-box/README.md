# collab-box — a containerized "second machine" for multi-machine tests

tlda's whole model assumes daemons can run on different machines than the server.
There was no way to exercise that locally (a second daemon on the same machine
collides on `machine_id`). This is that test box: a container with its own
`machine_id` that runs the tlda CLI + fleet-daemon and talks to the host server —
so we can actually test the multi-machine / collaborator flow.

First job: verify the **daemon-side source binding** (`tlda doc link`) — that a
collaborator's daemon watches/pushes **its own** local clone for a shared project,
driven by its local binding, not the server's `sourceDir`.

## Prereqs
- A docker daemon. On this machine that's **colima** (`colima start`), not Docker
  Desktop.
- The host tlda server running (`tlda server start`).

## Run
```bash
bash test/collab-box/run.sh
```
It creates a throwaway project, clones it, runs the container daemon bound to the
clone, edits a file in the clone, and checks the host project rebuilt. PASS = the
host rebuilds from the container's edit (the container's binding drove the
watch+push, since the server's `sourceDir` path doesn't exist in the container).

## Notes / things validated on first real run
- **Networking:** container → Mac host via `host.docker.internal:5176`. If colima
  doesn't expose that, try `host.lima.internal` or the host's tailnet IP.
- **TLS:** the dev server's cert is `localhost`-only, so the container sets
  `NODE_TLS_REJECT_UNAUTHORIZED=0`. (Fine for a local test; a real collaborator
  hits a properly-cert'd server.)
- **Mounts:** the collaborator clone lives under `$HOME` so colima's default mount
  exposes it to the container.
- **Image:** no TeXLive — a collaborator's daemon only watches/pushes source; the
  host server builds the LaTeX.
