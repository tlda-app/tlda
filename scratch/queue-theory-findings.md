# Queueing theory for supersedable jobs on k servers

A literature review, done abstractly and without reference to any tlda code, in answer to Skip's
instruction: *"there is like textbook queuing theory that gives a reasonable prio/killing rule for
this … have someone look it up … be abstract."*

Written by `queue-theory` (`fleet:b8f866b5`), 2026-08-18, for `chief-night`.

---

## Provenance: how much of this did I actually read

**Read this section before using anything below.** An abstract is a claim about a result, not the
result. Every substantive claim in this document carries one of these tags:

| tag | means |
|---|---|
| **[A]** | I fetched the paper's abstract page directly and read what it says. Still an abstract — I did not read the theorem statement, its hypotheses as written, or the proof. |
| **[S]** | Search-engine result summary only. I have the paper's title, authors, venue and a paraphrase of its claim. I did not open the paper. **This is the weakest tier and most of the document is in it.** |
| **[R]** | My own reasoning from the above. Not from any source. |

**I read no paper in full.** Exactly one abstract was fetched directly: Bedewy, Sun & Shroff,
arXiv:1709.04956 — and even that reached me as a summarizer's rendering of the abstract rather than
its verbatim text.

**What that means for use.** The *names* — of problems, disciplines, theorems, authors, venues — are
reliable enough to search on and are the durable part of this document. The *quantitative* claims
(the ~6% round-robin gap, "within a constant gap") are [S] and should be treated as pointers to check,
not as numbers. Any decision that turns on a theorem's exact hypotheses needs the paper opened first.

---

## 1. What the problem is called

There is no single name. The problem is the intersection of four literatures, each of which owns one
clause and none of which owns the whole. **[R]**

| clause | literature | its term |
|---|---|---|
| a source's newest job supersedes its own older queued job | **Age of Information (AoI) / status-update systems** | *packet management*, *packet replacement*, *obsolescence* **[S]** |
| the same thing, in engineering practice | market data; event distribution | **conflation** **[S]**; *coalescing*; *debounce/throttle* |
| N sources with rates differing by orders of magnitude | **fair queueing**; **polling / cyclic-service systems** | *flow isolation*; *gated* vs *exhaustive* service **[S]** |
| a completion invalidates other in-flight jobs | **optimistic concurrency control (OCC)** | *abort-and-restart*, *validation conflict* **[S]** |
| the queueing form of that | queueing theory | **preemptive-repeat** queue (as against preemptive-*resume*) **[S]** |

**Best single framing:** a *multi-source, multi-server status-update system with packet replacement*.
That is the model in Bedewy, Sun & Shroff — k servers, multiple flows, newest-wins, and the explicit
question of whether work already in service may be cancelled. **[A]**

**Best single engineering word, if you want one:** **conflation**. It names exactly the
newest-value-wins queue and it is what the market-data and event-distribution vendors call it. **[S]**

---

## 2. The two starvation directions

### 2a. A high-rate source starving a low-rate one

**Fair queueing.** Shreedhar & Varghese, *Efficient Fair Queueing using Deficit Round Robin*, SIGCOMM
1995 / IEEE-ACM ToN 1996. The guarantee is **isolation**: a source's throughput share is unaffected by
other sources' presence or misbehaviour, at $O(1)$ work per job, where the earlier exact schemes (GPS,
WFQ) cost $O(\log n)$. **[S]**

**Maximum Age First (MAF)** — the AoI analogue: serve the source whose information is oldest. Reported
claim: for any fixed sampling strategy, MAF gives the best age performance among all multi-source
scheduling strategies. **[S]**

**Round-robin is close.** Reported as within roughly 6% of optimal AoI asymptotically in a HARQ
multiaccess setting. **Treat the number as a pointer, not a figure** — it is [S] and its setting is not
obviously ours.

**The guarantee shape worth having** is the polling-system one, because it is a *bound* rather than a
*share*: under **gated** or **1-limited** cyclic service over N queues, a source waits at most one
cycle, and the cycle length does not depend on any single source's arrival rate. Reference: Takagi,
*Analysis of Polling Systems*, MIT Press 1986; closed forms via Boxma & Groenendijk's
pseudo-conservation laws. **[S]** — I have the existence and framing of these results, not their
statements.

### 2b. A high-rate source starving *itself*

**This is a real, named failure, and it is named three times in three literatures.** It is the failure
a naive coalescing rule has.

1. **Starvation under optimistic concurrency control.** Kung & Robinson, *On Optimistic Methods for
   Concurrency Control*, ACM TODS 6(2), 1981. A transaction repeatedly aborted by others' commits may
   never complete. **Their own prescribed fix is a serial fallback**: after repeated failure the
   starving transaction runs in a critical section / takes a whole-database write lock and is
   guaranteed to finish. **[S]**
2. **Debounce without `maxWait`.** A trailing-edge debounce never fires under uninterrupted input.
   `lodash.debounce`'s `maxWait` forces execution after a bounded delay regardless of continuing input;
   `throttle` is defined in lodash as debounce with `maxWait`. This is the same result with no math on
   it, and it is the version most engineers already know. **[S]**
3. **Preemptive-repeat instability.** A job restarted on every supersession is preemptive-repeat.
   Asmussen & Glynn, *On preemptive-repeat LIFO queues*, Queueing Systems 87:1–22, 2017: **the
   stability region depends on the distributions, not only on the rates.** So "supersessions happen
   less often than completions" is *not* a sufficient argument that anything ever gets through. **[S]**

**The fix I would take, and it is structural rather than a timer.** All three fixes above bolt a bound
on afterwards. The polling literature gives it by construction — **gated service**: at the instant the
server picks up a queue, what is present is *gated*, and later arrivals go into the next cycle. Applied
here: **[R]**

> **Supersession may overwrite the waiting slot. It may never cancel a job that has been dispatched.**

Each source is then served at least once per cycle regardless of how fast it submits; self-starvation
becomes impossible by construction rather than prevented by a guard that has to fire; and there is no
timeout to tune. **[R]**, though "gated service" and its one-cycle property are **[S]**.

### 2c. Whether you may cancel work *in service* is decided by the service distribution

The cleanest transferable result found, and it is a dichotomy:

- **Exponential (memoryless) service** — a preempted job's remaining service is distributed as a fresh
  job's, so preemption costs nothing. **Preemptive LGFS is age-optimal** in a stochastic-ordering
  sense over all causal policies. **[A]**
- **NBU service** (*New Better than Used*: a partly-served job has stochastically less work remaining
  than a fresh one; deterministic service is NBU) — preemption trades a short remainder for a full
  fresh draw, so it is **harmful**. **Non-preemptive LGFS** is reported within a constant gap of
  optimum. **[A]** for the statement; the size of the gap is **[S]**.

Jobs that are "long relative to arrival intervals" are usually NBU-ish, so **do not cancel work in
service** is what this literature recommends, not a compromise it tolerates. **[R]**

---

## 3. The standard result on supersession itself

**There is one and it is exact.** Costa, Codreanu & Ephremides, *On the Age of Information in Status
Update Systems with Packet Management* — ISIT 2014, then IEEE Transactions on Information Theory
62(4):1897–1910, April 2016; arXiv:1506.08637.

They define the **M/M/1/2\*** queue: one job in service, **one** waiting slot, and an arriving job
**replaces** whatever occupies that slot. They compute average age for it and for the two obvious
alternatives — M/M/1/1 (block arrivals while busy) and M/M/1/2 (a genuine FIFO buffer of two) — and
M/M/1/2\* wins. **[S]**

So the standard answer to *what discipline does supersession want* is: **a per-source buffer of depth
one, newest wins, in-service job left alone.** It also bounds memory at N jobs. **[S]** for the
result, **[R]** for the memory observation.

The discipline generalises as **LGFS — Last Generated First Served**: always serve the most recently
generated item. Bedewy, Sun & Shroff (arXiv:1709.04956) prove LGFS age-optimal (preemptive, exponential
service) and near-optimal (non-preemptive, NBU service) **for multi-server systems** — which is the k
in our statement. **[A]** Their multi-source policy is **P-MAF-LGFS**: give a server the newest item of
the source with the largest age. **[S]**

Composite the literature hands you:

> **MAF across sources · LGFS within a source · one slot per source with overwrite · non-preemptive in service.**

---

## 4. The simplest discipline that suffices — and it does suffice

**Skip's framing was that we probably will not have real concurrent editing and should not get fancy.
The literature agrees, and it agrees by theorem rather than by shrug.**

**Kleinrock's conservation law** — *A conservation law for a wide class of queueing disciplines*, Naval
Research Logistics Quarterly 12(2), 1965. For non-preemptive, work-conserving, non-anticipative
disciplines, $\sum_p \rho_p W_p$ is **invariant** over the discipline. A cleverer scheduler
*redistributes* waiting between sources; it cannot reduce the total. **[S]**

The consequence is the load-bearing one: **sophistication buys differentiation and nothing else.** If
you do not want to privilege one source over another, WFQ, virtual time and priority computation have
literally nothing to sell you over round-robin. **[R]**

**And rare contention means the discipline almost never binds at all.** Everything in §2 and §3
describes the burst. At low utilization queues are empty and every work-conserving discipline behaves
identically. **[R]**

**So, plainly: FIFO across sources with per-source depth-1 coalescing is provably fine here.** The
conditions under which that is *provably* sufficient are: **[R], assembled from the [S]/[A] results above**

1. you want no weighted differentiation between sources (Kleinrock — otherwise discipline is inert);
2. supersession is gated at dispatch (§2b — otherwise self-starvation);
3. service is not cancelled in flight (§2c — otherwise you pay the NBU preemption penalty);
4. the system is not in sustained overload (otherwise you need per-source delay *bounds*, which
   round-robin gives only as a one-cycle bound and which DRR/WFQ give tightly).

The four rules:

1. **One slot per source, newest wins** — freshness, memory bounded at N.
2. **Round-robin across sources** filling the k servers — one-cycle isolation bound. MAF instead only
   if you want to weight by staleness; DRR instead only if job sizes vary enough that a turn is not a
   share.
3. **Gate on dispatch** — overwrite the slot, never the running job.
4. **Non-preemptive in service** — because service is NBU.

This is DRR degenerating to plain round-robin over a conflated depth-1 buffer. No virtual time, no
weights, no priority key. **You would need the sophisticated version only for weighted shares or for
provable per-source delay bounds under sustained overload** — neither of which is on the list.

---

## 5. Assumptions the literature makes that we may violate

1. **Poisson arrivals; i.i.d. exponential or NBU service.** The age-optimality proofs need these. "One
   source submits continuously for minutes" is not Poisson — it is correlated and bursty. What survives
   is the *structure* (depth-1 overwrite, LGFS, MAF), proved by sample-path / stochastic-ordering
   arguments; the closed-form age numbers do not survive at all. **[R]** on which half survives.
2. **AoI optimizes staleness, not completion.** The AoI literature is *indifferent* to whether any
   particular submission is ever served — that indifference is precisely why supersession is free in
   it. If the requirement is ever "*this* job must complete", AoI is the wrong objective and the
   polling / fair-queueing framing is the right one. **[R]**, and it is the boundary I would watch
   hardest when someone reaches for an AoI result.
3. **Invalidation-on-completion is not in the AoI model at all.** No AoI result knows about one job's
   completion destroying another's in-flight work. That coupling is OCC's, and the finding there is
   Agrawal, Carey & Livny, *Concurrency Control Performance Modeling: Alternatives and Implications*,
   ACM TODS 12(4):609–654, 1987: restart-based methods **thrash** past a contention threshold, because
   work is repeatedly discarded rather than blocked. **[S]**

   **This couples directly to k.** More servers → more completions per unit time → higher invalidation
   rate, so **raising k can reduce goodput.** The sign of that effect is an empirical question about
   the invalidation coupling and is not answered by any multi-server queueing result I found. **[R]**
   The OCC remedy has the same shape as every other fix here: bound the restarts, then run the last
   attempt pessimistically. **[S]**
4. **Stability under restart is not a rate condition** (Asmussen & Glynn, §2b). Comparing an
   invalidation rate against a completion rate does not establish that the system drains. **[S]**
5. **Independence across sources.** Given in the problem statement. If invalidation correlates sources,
   the per-source decomposition that all of §3 rests on is no longer exact. **[R]**

---

## 6. What this does not answer

- **"An invalidated job can be transformed and resubmitted."** Queueing models restart a job as
  *itself*, or replace it with a *fresh* one. A job that becomes a *different* job on invalidation has
  no standard model I found. The nearest neighbour is the retrial / G-queue literature (negative
  customers; signals that transform customers), which is analysis machinery rather than a scheduling
  rule, and I would not stretch it into one.
- **Failure requiring new input from the source rather than a retry.** Queueing-theoretically this is a
  departure plus an out-of-band re-trigger. No discipline affects it; the only design question is
  whether the source is told, which is not a scheduling question.
- **Choosing k.** The multi-server AoI results assume independent servers. Under invalidation coupling
  they are not, and I found no result giving an optimal k.
- **The composite in §4 is an assembly, not a theorem.** Each of the four rules is proved in its own
  model, under its own assumptions. Nothing I read proves the combination optimal for this combination
  of clauses, and it should not be represented as proved.

---

## Sources

Tier in brackets is how *I* consumed it, not the source's quality.

- **[A]** Bedewy, Sun & Shroff, *Minimizing the Age of Information through Queues* — arXiv:1709.04956.
  LGFS; multi-server; preemptive/exponential vs non-preemptive/NBU.
  <https://arxiv.org/abs/1709.04956>
- **[S]** Bedewy, Sun & Shroff, *Age-Optimal Information Updates in Multihop Networks* — arXiv:1701.05711.
- **[S]** Bedewy, Sun & Shroff, *Age-Optimal Updates of Multiple Information Flows* — arXiv:1801.02394. P-MAF-LGFS.
- **[S]** Costa, Codreanu & Ephremides, *On the Age of Information in Status Update Systems with Packet
  Management* — ISIT 2014; IEEE Trans. IT 62(4):1897–1910, 2016; arXiv:1506.08637. The M/M/1/2\* result.
- **[S]** Yates et al., *Age of Information: An Introduction and Survey* — arXiv:2007.08564. MAF; field overview.
- **[S]** *Round-Robin is Provably Near-Optimal for Minimizing Age with HARQ over Heterogeneous
  Unreliable Multiaccess Channels* — arXiv:2010.10861. Source of the ~6% figure.
- **[S]** Shreedhar & Varghese, *Efficient Fair Queueing using Deficit Round Robin* — SIGCOMM 1995.
  <https://courses.cs.duke.edu/fall24/compsci514/readings/drr.pdf>
- **[S]** Kleinrock, *A conservation law for a wide class of queueing disciplines* — Naval Research
  Logistics Quarterly 12(2), 1965.
- **[S]** Boxma & Groenendijk, *Pseudo-Conservation Laws in Cyclic-Service Systems*; Takagi, *Analysis
  of Polling Systems*, MIT Press 1986.
- **[S]** Kung & Robinson, *On Optimistic Methods for Concurrency Control* — ACM TODS 6(2), 1981.
- **[S]** Agrawal, Carey & Livny, *Concurrency Control Performance Modeling: Alternatives and
  Implications* — ACM TODS 12(4):609–654, 1987.
- **[S]** Asmussen & Glynn, *On preemptive-repeat LIFO queues* — Queueing Systems 87:1–22, 2017.
- **[S]** Conflation as the engineering term — DiffusionData and Apache Geode product documentation.
