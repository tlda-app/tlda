# Title restore mapping — all 87 stamped rows

Read from the testing store at 2026-09-01T23:22:18.630Z. Source for every row is a
delegate event, read directly off `events.text` for that `task_id`. No timestamp join,
no reconstruction. Nothing has been written.

**How the source is exact.** `transferTaskLifecycle` emits its delegate event with
`task.description` — the value *before* the transfer overwrites it. So the event that
wrote a stamped title also carries, in its own `text`, the title it displaced. Where a
row was handed off more than once, the walk steps back through each consecutive stamp;
`chain` is how many hops. `event` is the id whose `text` is the restored string —
check any of them with `thread(message_id: <id>)`.

**Groups: 50.** A group is one bulk hand-off; every row in it currently reads the same.

## 25 rows now reading “Parking stale backlog task during fleet cleanup — owner hibe”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:1cb6-mstsbkr0` | Independently gate layout and obligations | 2802138 | 2 |
| `fleet:20c3-mssjkl4p` | Watch post-revert chat telemetry | 2847265 | 1 |
| `fleet:2268-mstsmg6y` | Gate stray upload refusal | 2847256 | 1 |
| `fleet:278f-ms9tkedg` | Build gesture transitions in the tldraw fork | 2847276 | 1 |
| `fleet:2ebc-ms8gge19` | Make composer slider salient on touch | 2847279 | 1 |
| `fleet:35ad-msb52r3a` | Split metadata.source into via and source | 2847271 | 1 |
| `fleet:462e-msa447dr` | CLI command for an agent to restart its own MCP | 2847273 | 1 |
| `fleet:4b96-msjw7gp3` | Fix invisible math-agent messages | 2847270 | 1 |
| `fleet:58d0-mstrjqxc` | Close post-WMRC bug set | 2800306 | 3 |
| `fleet:5c83-mstsmii0` | Gate late-alpha release preparation | 2847255 | 1 |
| `fleet:6750-msmhnllc` | Task expiry notifications and timer path | 2847267 | 1 |
| `fleet:700d-msts1dec` | Finish chat scrolling workstream | 2801539 | 3 |
| `fleet:7ed0-msts9vj6` | Capture real iPad touch telemetry | 2802077 | 4 |
| `fleet:80dd-ms8ligy7` | Recover and build the index page columns | 2847277 | 1 |
| `fleet:8266-mstsmdf1` | Gate docs and Overleaf onboarding | 2847257 | 1 |
| `fleet:8652-msb429rs` | Build the gesture classifier in the tldraw fork | 2847272 | 1 |
| `fleet:99d0-mstrqvrn` | Gate shared highlighter repair | 2847263 | 1 |
| `fleet:9ccb-msa3gfqi` | Stop tlda daemon stop from unloading the launchd job | 2847274 | 1 |
| `fleet:a23b-msa2bmx3` | Delete wiretaps | 2847275 | 1 |
| `fleet:a439-msjwp1z9` | Restore lifecycle authority and Reanimate | 2847269 | 1 |
| `fleet:a5d4-ms80jobb` | Rebuild index page to Skip's spec | 2847280 | 1 |
| `fleet:aa50-msts1cfc` | Carry accepted WM outputs forward | 2847262 | 1 |
| `fleet:de11-mstsm97b` | Gate short image references | 2847258 | 1 |
| `fleet:efeb-mspm4yca` | Work with Skip on the tlda README | 2847266 | 1 |
| `fleet:f207-msm009ep` | Interleaved two-writer editing session test | 2847268 | 1 |

## 9 rows now reading “Transferred from an Opus agent to the nobody bot at Skip's r”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:277f-msqraoeq` | Hold Enter until the voice transcript finalizes | 2754385 | 1 |
| `fleet:2dbc-msqxdmin` | Independent check on the chief, per Skip's ask | 2754384 | 1 |
| `fleet:5593-msofhooo` | Build document place-stack navigation | 2754389 | 1 |
| `fleet:8160-msqor5h1` | Fix and run worktree cleanup safely | 2754386 | 1 |
| `fleet:87a8-msqdh6mt` | Own sync as a domain, working directly with Skip | 2754387 | 1 |
| `fleet:87a8-msrlxvei` | Triage the 26 stale fleet tasks | 2754382 | 1 |
| `fleet:9d03-msptpck7` | Advocate seat for app recovery | 2754388 | 1 |
| `fleet:afa6-msifk6gm` | Runaway/echoing voice on testing | 2754390 | 1 |
| `fleet:edff-msrlvzpj` | A bounded search refuses results it holds | 2754383 | 1 |

## 5 rows now reading “Ownership transfer while the chief/package lane has the next”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:3536-mthb7l9w` | Repair classroom visual-mode readability | 3495570 | 5 |
| `fleet:7dca-mthb7j23` | Deliver real Positron submission path | 3497496 | 4 |
| `fleet:bc8d-mthyusax` | Repair classroom microphone and icon | 3546950 | 1 |
| `fleet:bc8d-mti8rot0` | Verify classroom and extension behavior | 3546947 | 1 |
| `fleet:e1f8-mthb7n8c` | Establish and finish classroom layers | 3495730 | 4 |

## 2 rows now reading “URGENT, live, blocking Skip right now — he cannot view his B”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:7608-mswu27lb` | URGENT, live, blocking Skip right now — he cannot view his B | 2859879 | 1 |
| `fleet:85f8-mswu9ude` | URGENT, live, blocking Skip right now — he cannot view his B | 2859925 | 1 |

## 1 row now reading “**Carried list, 18:30.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:3535-mtiwcv3p` | Carry every open item from his ask | 3565650 | 2 |

## 1 row now reading “**Class is long over.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:3535-mtix1tzf` | Get my work checked by an advocate | 3565574 | 2 |

## 1 row now reading “**Class is over — 17:50, his words: "im done with class dude.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:3535-mtisldyz` | Not idle while his ask is unmet | 3554555 | 3 |

## 1 row now reading “**Item 8, final piece of the design, from Skip.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:8a77-msz0hzqx` | Untracked items from tonight — split and own | 2969014 | 5 |

## 1 row now reading “**Stood down from this seat by Skip, 2026-08-22 ~18:44 EDT**”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:a6a6-mt3wy106` | Take singular chief seat and execute queue | 3175699 | 3 |

## 1 row now reading “**This is the seat's recurring obligation and the seat is yo”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:0a55-msy4hu3k` | Hourly status to Skip; keep the seat awake | 2965420 | 1 |

## 1 row now reading “**This task is Skip's and it is now yours.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:f358-mt5koo2v` | Read my thread, tell me what to do | 3228065 | 1 |

## 1 row now reading “**Transferring because the next action is yours.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:2b6f-mt99gmd5` | Replay José meeting as acceptance test | 3336512 | 1 |

## 1 row now reading “# handback ⏎  ⏎ **Handing this back because every remaining acti”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:5ed6-msy3z558` | A deploy must not interrupt Skip | 2927466 | 1 |

## 1 row now reading “## How I work — Skip, 09-01 13:0x EDT ⏎  ⏎ > YOU DO NOT HAVE THE”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:3535-mtiwlaoz` | The Lab 1 deck Skip asked for | 3559937 | 1 |

## 1 row now reading “Acceptance addition from Skip, chat#3086828: finish the narr”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:ce18-mt2ianqs` | Finish project document surfaces | 3086234 | 5 |

## 1 row now reading “Add Skip message 3028421 as a required convergence-harness u”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:3d1d-mt16fjqd` | Build adversarial sync convergence harness | 3027582 | 2 |

## 1 row now reading “Candidate ready for integrated current-main and advocate rev”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:1a87-mt3hreqz` | Agent search results | 3145789 | 1 |

## 1 row now reading “Canonical ownership transfer.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:3546-mt1bjiyc` | Implement lexical me in thread cards | 3052717 | 1 |

## 1 row now reading “Citation correction: final scope authority is chat#3071535 a”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:98ec-mt2572ib` | Trace orphan horizontal snap guide | 3071072 | 8 |

## 1 row now reading “Corrected candidate returned — transferring, since by your o”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:83dc-mt3n697o` | Restore and prove Todd UI cycle | 3151897 | 3 |

## 1 row now reading “Correction superseding the deck-as-peer phrasing: Skip says”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:cbcd-mt3njv17` | Own classroom and Quarto delivery | 3150454 | 1 |

## 1 row now reading “Correction/addition from Skip, chat#3085884: generate the th”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:3546-mt2hu61r` | Repair classroom around QTM 285 | 3085859 | 2 |

## 1 row now reading “Drop-test complete; no task work was performed.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:bef7-mstd2m0d` | Diagnose SNMM kernel scaling bias | 2787203 | 2 |

## 1 row now reading “Handing this back to you because the next action is yours, n”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:003f-mt5qxls4` | Write the intro live with Skip | 3253775 | 1 |

## 1 row now reading “Integrated PIC-dev stage is complete and production is uncha”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:a4fe-mtga9gm3` | Stage QTM285 bundle on PIC-dev | 3487450 | 1 |

## 1 row now reading “Maintained Markdown draft sent directly in message 3136654 f”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:4786-mt3b0519` | Write introduction paragraphs from Skip's template | 3132636 | 3 |

## 1 row now reading “New, urgent, separate bug — Skip just reported it live: "FUC”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:85f8-mswotfwy` | New, urgent, separate bug — Skip just reported it live: "FUC | 2857694 | 1 |

## 1 row now reading “Next action is your independent PASS/BLOCK on exact held com”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:9fae-mti8rdmb` | Repair classroom release and build process | 3532356 | 1 |

## 1 row now reading “Primitive-condition repair is complete and reported in messa”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:96e0-mt25ohpo` | Construct minimal permutation comparison proof | 3113863 | 1 |

## 1 row now reading “Reassigning from bhief-of-staff, who correctly stopped rathe”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:efbf-msxdl5ez` | Track live sync-rejection regression until resolved | 2887369 | 1 |

## 1 row now reading “Recover this existing classroom PM session and carry the att”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:58e2-mt9e5qcf` | Own classroom delivery | 3336336 | 1 |

## 1 row now reading “Recovered canonical record and created `/Users/skip/worktree”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:1753-mt20lltk` | Finish agent status redesign | 3058312 | 1 |

## 1 row now reading “Recovery trigger: resume this exact existing integration tas”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:4589-mt1yg3zr` | Integrate accepted fixed-count proof | 3056339 | 1 |

## 1 row now reading “Remaining work only: verify search-card-one-control on its o”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:500d-mtc3dseh` | Own fleet search reliability | 3413147 | 2 |

## 1 row now reading “Restore the advocate task to the newly minted `sol-dev-advoc”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:4463-mt9ko6ad` | Independently advocate for Skip | 3355161 | 2 |

## 1 row now reading “Returned unchanged.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:skip-msusyopn` | Review homework package allocation | 3027070 | 1 |

## 1 row now reading “Scope update from the settled 16:00:20–16:20:18 EDT classroo”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:skip-msusypg1` | Choose registration link distribution | 2837406 | 1 |

## 1 row now reading “Second, different chat-scroll bug — live and urgent, Skip is”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:85f8-mswhot8v` | Second, different chat-scroll bug — live and urgent, Skip is | 2853228 | 1 |

## 1 row now reading “Skip finalized the conflict workflow in messages 3028492–302”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:383b-mt17cv5g` | Implement daemon-owned Overleaf sync | 3028347 | 3 |

## 1 row now reading “Skip just reported (2026-08-16, ~4:45 PM EDT, verbatim): "I”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:521b-mswa1fa5` | Skip just reported (2026-08-16, ~4:45 PM EDT, verbatim): "I | 2846543 | 1 |

## 1 row now reading “Take ownership and implement the task as assigned by the cur”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:dev-mt2a0iua` | Update Git cutover canaries | 3080542 | 1 |

## 1 row now reading “Taking this back off my queue — the next action is yours, so”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:8f73-msydfqd6` | Put B.2 back on the scalar template | 2941408 | 2 |

## 1 row now reading “Task remains intentionally unstarted under your chat#3067914”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:6b03-mt20170m` | Make permissions command perform reprofile cycle | 3113158 | 1 |

## 1 row now reading “The owner-only bootstrap action is already satisfied.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:98d6-mstpvof2` | Prove Bregman two-way replica sync | 2795685 | 17 |

## 1 row now reading “This older classroom audit/repair task is now in assembly an”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:9fae-mthyusyh` | Audit and repair classroom defects | 3532375 | 1 |

## 1 row now reading “Transferring per your ruling — nothing on this list is mine”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:4e69-msxvildg` | Grind the backend cleanup list to nothing | 2928627 | 1 |

## 1 row now reading “Update before you start: Skip added detail and pointed you a”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:a3f4-mswadp6j` | Update before you start: Skip added detail and pointed you a | 2846949 | 1 |

## 1 row now reading “Urgent, live right now: Skip and other agents' mint attempts”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:9c98-mswppfi4` | Urgent, live right now: Skip and other agents' mint attempts | 2857947 | 1 |

## 1 row now reading “WITHDRAWN BY SKIP 2026-08-18 ~01:25 EDT.”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:742e-msy72n62` | Parked: Skip's unfinished objection to Lemma A.14 | 2927896 | 1 |

## 1 row now reading “You are the independent Claude advocate for the tlda chief-o”

| task | restore to | event | chain |
|---|---|---|---|
| `fleet:a3f6-msuyp7xc` | You are the independent Claude advocate for the tlda chief-o | 2844609 | 1 |
