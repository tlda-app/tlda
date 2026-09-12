# Tier-2 commits inside S8 — the fired chief's implementers

39 of route-probe-cn's 64. Attribution is by author EMAIL (fleet id), from the
delegation record of chief fleet:0a554e63 ("chief" -> now solved-non-problems),
not by author name. Both chiefs authored ZERO commits themselves.

SHA         COMMITDATE            AGENT                      SUBJECT
ee508ca17   2026-08-18 01:18:37   app-lockup                 Stop storing a second copy of pushed file bytes in the operation journal
c9bfa258e   2026-08-18 01:18:37   edits-dont-reach-the-file  Give an unanswered source push a deadline, and stop the two lies beside it
9b5dcaafe   2026-08-18 01:18:37   sync-manifest-reconcile    Stop copying the version history into every push
218d50751   2026-08-18 01:18:38   app-lockup                 Apply the journal storage shape to every record, not just the new one
006036217   2026-08-18 01:18:38   app-lockup                 Stop reading a whole git log to compute two numbers
2787cc075   2026-08-18 01:18:38   app-lockup                 Write down the init-filter narrowing readShadowIndexInfo introduced
8960db602   2026-08-18 01:18:38   msgid-reference            Chip a bare message id in chat again
27e3ccd04   2026-08-18 01:18:39   msgid-reference            Make unchecking Agent subtitles stop the one on screen
ed300a58c   2026-08-18 01:18:39   msgid-reference            Read a message back by the id we hand out
eb9a5cb47   2026-08-18 01:18:40   sync-manifest-reconcile    Say which checkout each daemon actually runs
d57aafabb   2026-08-18 01:24:14   msgid-reference            Allow the message-id wire test its socket
b6161bc45   2026-08-18 01:50:39   msgid-reference            Show the last good render while a rebuild runs
ec83ccdaa   2026-08-18 02:01:30   fleet-db-blocking          Stop a thread read from materializing an agent's whole history
b9593f59f   2026-08-18 02:01:31   app-lockup                 Reference the stale-base evidence instead of copying it into the journal
5838959dc   2026-08-18 02:01:31   edits-dont-reach-the-file  Drop the settle deadline to 300s now the 14 GB copy is gone
0ce9b6722   2026-08-18 02:01:31   edits-dont-reach-the-file  Push the edit he made just before the daemon restarted
5296f6867   2026-08-18 02:32:58   msgid-reference            Discard a build that finishes after a newer one
a896569ec   2026-08-18 03:32:58   edits-dont-reach-the-file  Reproduce, over the wire, the accept that deleted his prose
b9d4302ae   2026-08-18 03:33:36   edits-dont-reach-the-file  Stop the spec and its tests asserting the bug as a requirement
f2253daac   2026-08-18 03:38:43   edits-dont-reach-the-file  Allow the source wire harness its daemon socket
6001197b4   2026-08-18 04:12:14   actual-versioning          Make a source revision a commit
67a109593   2026-08-18 04:12:14   actual-versioning          Mirror on accept, so a push commits the author's checkout
c16e8472a   2026-08-18 04:12:15   actual-versioning          Delete the build-era mirror, and its switch with it
901055fa0   2026-08-18 04:12:15   actual-versioning          Say what the mirror does to a dirty checkout
17b0d9c6a   2026-08-18 04:12:16   msgid-reference            Say why the doc-version reload guard is not a missing null check
53718a35b   2026-08-18 05:27:45   actual-versioning          A failed mirror is not a failed build
d89d20bb8   2026-08-18 05:44:47   actual-versioning          Run one mirror at a time per project
7390a7ba5   2026-08-18 06:11:21   msgid-reference            Stop one message pinning the head of the daemon's delivery queue
9c5b74942   2026-08-18 06:11:21   msgid-reference            Tell an agent macros did not load instead of that it has no preamble
2e58f9583   2026-08-18 07:05:36   actual-versioning          Surface a refused push where its author can see it, and make the spec current
b13ed14c8   2026-08-18 07:05:36   fleet-db-blocking          Make a thread read mean the conversation, not a slice of one participant
ae248d55e   2026-08-18 07:13:05   actual-versioning          Forward refusedRevision across the mirror RPC
220b83b7f   2026-08-18 07:13:06   actual-versioning          Assert the whole mirror payload, not the fields someone remembered
945d7df89   2026-08-18 07:13:07   mint-attaches-its-task     Attach a mint's task in the same operation that mints it
48abaff67   2026-08-18 07:13:08   fleet-db-blocking          Sweep activity search entries past 30 days, and only those
51f477b9f   2026-08-18 07:13:08   he-is-not-the-monitor      Share one bot-heartbeat survey, so a bot's death has a witness
fe0484686   2026-08-18 07:21:23   edits-dont-reach-the-file  Prove a refused push reaches the checkout, over the wire it crosses
cfc1cdb43   2026-08-18 13:27:46   actual-versioning          Accept a proposed commit iff it fast-forwards
6f6a18117   2026-08-18 13:27:46   actual-versioning          Say that the new accept path has no post-accept effects yet
