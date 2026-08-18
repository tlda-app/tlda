# Reclaiming space in `fleet.db` — runbook

**Do not run this outside a maintenance window.** It stops the server. Written
2026-08-18 by `fleet-db-blocking` at the chief's request; the chief owns the
window and the release path.

## Why anything is needed

`fleet.db` on `tldraw-sync-skip` is **10,209,529,856 bytes**. `auto_vacuum` is
**`0` (NONE)**, so every `DELETE` returns pages to SQLite's freelist and none of
them to the filesystem. Measured the same day:

```
page_size      = 4096
page_count     = 2,492,561
freelist_count = 122,445 pages  =  501 MB already free INSIDE the file
```

So the file will not shrink on its own, and it will not shrink because of the
activity-FTS sweep either. **Pruning stops growth and cuts search latency; only
this procedure moves the number on disk.**

`auto_vacuum` cannot be switched to `INCREMENTAL` afterwards — the mode is fixed
when the database is created, and changing it requires a full `VACUUM` anyway.

## Why not plain `VACUUM`

`VACUUM` rewrites the database in place holding an exclusive lock for the whole
rewrite. On ~10 GB that is minutes during which **every writer blocks**, and this
is the database behind chat, inbox, search and the roster. Writes that arrive in
that window do not queue politely — they strand.

`VACUUM INTO` writes a *new* file while the original stays readable, so the
outage is the swap, not the rewrite.

## Before you start

- **Free space.** `VACUUM INTO` needs room for a second copy. `/app/server/persist`
  was 34G used of 99G, so ~10 GB of headroom is fine — re-check, do not assume.
- **Know the current size**, so the result can be compared:
  ```sh
  fly ssh console -a tldraw-sync-skip -C "ls -l /app/server/persist/tlda-config/fleet.db"
  ```
- **Nothing else deploying.** Two `fly deploy` runs six seconds apart already cost
  six minutes of downtime once (AGENTS.md §Repository workflow). One operator.

## Procedure

**1. Stop the server.** The store must have no writers. A machine stop is the
honest way to guarantee that; anything subtler leaves the daemon reconnecting
mid-swap.

```sh
fly machine stop 2861e43b404798 -a tldraw-sync-skip
```

**2. Checkpoint the WAL, then vacuum into a new file.** The WAL was 398 MB; an
uncheckpointed WAL means the copy is missing recent commits.

```sh
fly ssh console -a tldraw-sync-skip -C "sh -c '
  cd /app/server/persist/tlda-config &&
  node -e \"
    const D=require(\\\"/app/node_modules/better-sqlite3\\\");
    const d=new D(\\\"fleet.db\\\");
    d.pragma(\\\"wal_checkpoint(TRUNCATE)\\\");
    d.exec(\\\"VACUUM INTO \\\\\\\"fleet.db.vacuumed\\\\\\\"\\\");
    d.close();
  \" && ls -l fleet.db fleet.db.vacuumed'"
```

**3. Verify the new file before it becomes the real one.** This is the step that
must not be skipped: a truncated or corrupt copy that gets moved into place is
the whole fleet's history gone.

```sh
fly ssh console -a tldraw-sync-skip -C "sh -c '
  cd /app/server/persist/tlda-config &&
  node -e \"
    const D=require(\\\"/app/node_modules/better-sqlite3\\\");
    const a=new D(\\\"fleet.db\\\",{readonly:true});
    const b=new D(\\\"fleet.db.vacuumed\\\",{readonly:true});
    const q=s=>[a.prepare(s).get().c, b.prepare(s).get().c];
    for (const t of [\\\"events\\\",\\\"recipients\\\",\\\"agents\\\",\\\"tasks\\\",\\\"session_entries\\\"]) {
      const [x,y]=q(\\\`SELECT COUNT(*) c FROM \\\${t}\\\`);
      console.log(t, x, y, x===y?\\\"OK\\\":\\\"MISMATCH\\\");
    }
    console.log(\\\"integrity\\\", b.pragma(\\\"integrity_check\\\",{simple:true}));
  \"'"
```

**Every table must match and `integrity` must be `ok`. If anything does not,
stop, delete `fleet.db.vacuumed`, and restart the machine — you have lost
nothing.**

**4. Swap, keeping the original.** Rename rather than delete: if the new file
misbehaves under real load, the way back is another rename.

```sh
fly ssh console -a tldraw-sync-skip -C "sh -c '
  cd /app/server/persist/tlda-config &&
  mv fleet.db fleet.db.prevacuum &&
  mv fleet.db.vacuumed fleet.db &&
  rm -f fleet.db-wal fleet.db-shm &&
  ls -l fleet.db fleet.db.prevacuum'"
```

Deleting `-wal`/`-shm` is required: they belong to the old file and SQLite will
otherwise try to recover a WAL against a database it does not match.

**5. Start, and check the surface rather than the logs.**

```sh
fly machine start 2861e43b404798 -a tldraw-sync-skip
```

Then, from an agent seat: `roster()`, `inbox()`, and a `thread()` read that
returns known-recent messages. The store is proven by the app answering, not by
the process being up.

**6. Only once it has served real traffic, reclaim the backup.**

```sh
fly ssh console -a tldraw-sync-skip -C "rm /app/server/persist/tlda-config/fleet.db.prevacuum"
```

Leave it at least a full working session. It is the only rollback.

## What to expect

Roughly the 501 MB of freelist, plus whatever the activity-FTS sweep has freed
by the time this runs (up to ~0.57 GB — 603,124 of 1,092,963 activity events
were past 30 days when measured), plus fragmentation recovered by the rewrite.

**It does not reclaim 3.82 GB.** The FTS indexes are the search index for data
being kept deliberately; see the decision recorded in
`fleet-store-blocking-2026-08-18.md`.

## If it goes wrong

- **Vacuum fails or disk fills:** `rm fleet.db.vacuumed`, start the machine. The
  original was never touched.
- **Server misbehaves after the swap:** stop, `mv fleet.db.prevacuum fleet.db`,
  remove `-wal`/`-shm`, start. Any events written since the swap are lost, which
  is why step 5 is checked immediately rather than the next morning.
