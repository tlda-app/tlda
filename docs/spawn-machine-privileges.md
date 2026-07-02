# Machine-local spawn privileges

Spawn authority is decided on the machine that will launch the child process.
The server routes the request, identifies the requester, and records the daemon's
reported outcome; it does not decide the local filesystem privilege grant.

## Target model

Privileges are operation-plus-zone sets attached to an agent on a box. Spawning
on a box creates or updates the child agent's privileges on that same box. For
each operation, the child receives only zones in the intersection of:

- the requested child privilege set,
- the target project's allowed zones,
- the target model's allowed zones,
- the local box policy for the requesting agent and target project,
- the requesting agent's current privileges on that box.

Requests broader than the intersection are clamped to the intersection, not
rejected just because they asked for too much.

The current implementation still uses the four existing labels (`read`, `write`,
`tlda-write`, `full`) as UI/config shorthands for nested operation-zone sets:
`cwd`, `tlda-projects`, and `unsandboxed`. Because those zones are nested today,
the resolver can implement intersection by compiling each shorthand to a policy
and taking the meet. Future non-nested zones should compile labels to explicit
sets before intersection.

## Machine policy

Machine-local configuration lives in the daemon's active config. At boot, the
daemon creation is the bootstrap grant: the daemon owner grants itself whatever
local privileges it wants on that box. Spawn is the operation of creating a child
with a subset of privileges already available on that box, then intersecting
with project and model constraints.

Non-owner agents are bounded by their recorded privilege on the box. A box can
also define `spawnPolicy.localSpawnAcl` keyed by requester and project, for
example:

```json
{
  "spawnPolicy": {
    "localSpawnAcl": {
      "fleet:skip": { "/Users/skip/work/tlda": "full", "*": "write" },
      "*": { "*": "write" }
    }
  }
}
```

`spawnPolicy.machineGrant` is a temporary emergency wildcard for this box. It is
equivalent to allowing every requester/project up to that level locally; it still
intersects with the project, model, and spawner terms.

## Spawn Interface

Agents and humans request child privileges at spawn time. The interface is a
request, not an authority grant: the daemon compiles the request on the target
machine and clamps it against the spawner's delegable privileges, project policy,
model policy, and local box policy.

Primary routed CLI form for normal agent plumbing:

```sh
tlda agent spawn mini:app-fixer --privileges app-dev
tlda agent spawn app-fixer --privileges app-dev
```

The prefix chooses the target machine for routed spawn, like SSH/rsync. An
omitted prefix resolves through the caller's configured default spawn machine,
with the existing loud failure if no unique/default machine exists.

`spawn-direct` is the local primitive and operator escape hatch. It bypasses the
server and invokes the local spawn compiler/launcher directly on the current box:

```sh
tlda agent spawn-direct app-fixer --privileges app-dev
```

Operators may use out-of-band mechanisms such as SSH to run that same direct
primitive on another box, but that inherits OS-user authority and is not normal
agent plumbing. Future safe SSH/direct transports must preserve or fence
delegated privileges instead of silently escalating to OS-user full authority.
Agents should normally use routed `spawn`, not `spawn-direct`, unless explicitly
operator-directed. The privilege/profile syntax, compiler, and clamping semantics
are shared where applicable.

MCP passes the same request as the `privileges` field:

```json
{
  "name": "mini:app-fixer",
  "fresh": true,
  "privileges": "app-dev"
}
```

The legacy `--capability read|write|tlda-write|full` / `capability` field remains
a shorthand request. New callers should use `privileges` so the request can move
from four nested labels to operation-plus-zone sets without changing the spawn
surface.

Humans should define named profiles on the daemon, not enumerate fully expanded
sets in every spawn call. The approved human-facing profile syntax is:

```text
profile app-dev:
  read  + /Users/skip/work/tlda/**
  write + /Users/skip/work/tlda/**
  write + /tmp/tlda-*/**
  read  - ~/.ssh/**
  write - ~/.ssh/**
```

Rules are ordered allow/deny patterns per operation, with gitignore-style zone
patterns. The daemon compiles a referenced profile name into concrete
operation-zone sets on that box, then performs the intersection. Profile names
such as `full`, `app-dev`, and `math-project` are the stable interface; their
definitions are daemon-local machine policy.

For operator CLI workflows, `--privileges <path>` may point at a privilege spec
file. JSON files can carry `{ "profile": "app-dev" }`; text files can carry the
profile-rule syntax above. A file form is still a request and is compiled and
clamped by the target daemon.
