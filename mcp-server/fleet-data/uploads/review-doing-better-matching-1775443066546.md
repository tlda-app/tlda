# Review: "Doing Better" and "Matching for Balance"

## Doing Better (Section 5.4)

**This section is strong.** The narrative arc — true weights aren't a ceiling, estimated weights can beat them, the modulus of continuity quantifies by how much, and the same fixed-point radius governs both regression and balance — is clean and well-motivated. A few things that feel off:

### 1. Transition into the modulus of continuity is abrupt

The paragraph starting "The results above establish that balancing weights can beat the true weights, but they do not tell us by how much" (line 1357) shifts from the Hirano/Chan/RKHS results to the minimax linear functional literature in one sentence. The reader goes from "balancing weights beat true weights" to "modulus of continuity" with no bridge explaining *why* we need the modulus machinery — just that other results don't "tell us by how much." A sentence or two about what question the modulus answers that the previous results don't would help. Something like: the previous results show $o_p(n^{-1/2})$ imbalance is achievable, but the modulus framework tells us the *rate* at which imbalance vanishes and connects it to the geometry of the model.

### 2. "approximately linear" could use unpacking

Line 1369: "When $\omega$ is approximately linear — $\omega(s) \approx cs$ for some constant $c$ — the maximal imbalance is approximately zero." This is the punchline but it's stated without intuition for *why* linearity of the modulus means small imbalance. The formula $\omega(s) - \omega'(s)s$ is the gap between the secant and the tangent, i.e. the deviation from linearity, but the reader has to do that calculation themselves. One sentence connecting the formula to the geometric picture would land the point better.

### 3. The approximation condition in Proposition 4 is dense

The condition "there exists a function $g$ with $\|g\|_\mathcal{M} \le C r^2 n/\sigma^2$ and $\|g - \gamma^{ipw}\|_{L_2(P)} \le C r^2 \sqrt{n}/\sigma$" (line 1376) appears inline, is hard to parse, and its role isn't immediately clear. It's saying the propensity weights can be approximated well enough in the model — but the two conditions on $g$ (model norm and $L_2$ distance) are doing different jobs that aren't explained. The prose says "a smaller $\sigma$ or larger $n$ makes the penalty cheaper, allowing a richer comparison function" — which is helpful — but it's doing the work of explaining the condition *after* the condition has already been stated. Consider either (a) motivating the condition before stating it, or (b) displaying it rather than burying it inline.

### 4. The last paragraph on augmentation feels tacked on

"Where does this leave augmentation?" (line 1409) — the answer is short and conclusive, which is fine, but the pivot to nonconvex models / sparse models feels like it opens a door and immediately closes it. If the synthesis paper is making a case that augmentation's biggest value is in nonconvex settings, this deserves more than one sentence. If it's a pointer, it could be a remark or a forward reference rather than a dangling paragraph.

### 5. "Because" vs "since" (style guideline)

Not a problem in these sections — just noting I checked.

---

## Matching for Balance (Section 7)

**The opening paragraph is excellent** — it cleanly motivates why integer weights matter (cost savings in longitudinal studies) and frames the section's question. The discrepancy theory material is well-explained and pedagogical. Issues:

### 6. The comment block at line 1508 should be cleaned up

There's a large block of raw planning notes still in the source. Not a writing issue per se, but it's distracting when reading the source.

### 7. "To state results precisely" paragraph (line 1514) has notation overload

This paragraph introduces $\hat\psi^{IPW}$, $\theta_i$, $\bar W$, $\overset{\neg}{W}_i$, rescaled weights, the ATT framing — all in quick succession. The sentence "Here we have written our estimator in terms of the rescaled weights $\theta_i = \gamma_i/\bar W$ appropriate when dividing by $N_1$ and written $\overset{\neg}{W}_i$ for $1 - W_i$" is doing a lot of notational housekeeping in one breath. It would read more cleanly if the notation were introduced one piece at a time, with each piece motivated.

### 8. The flow from Bernoulli rounding to deterministic rounding is hard to follow

Lines 1529–1549: We get the Bernoulli rounding variance decomposition, then equation (matching cost lower bound), then the deterministic rounding variance — but the logical thread is: (a) Bernoulli rounding is simple but wasteful, (b) there's a lower bound on the cost any matching estimator pays, (c) deterministic rounding achieves this bound. The text presents (a) then (b) then (c), but the transition from (a) to (b) is jarring — line 1537 says "This attainable lower bound, in which the conditional variance $v_0(X_i)$ replaces Bernoulli rounding's $Y_i^2$, is what matching costs" but it's not clear what "this" refers to yet, because the lower bound hasn't been stated. The sentence seems to be pointing forward to equation \eqref{eq:matching-cost} but reads as if it's pointing backward. This is the hardest paragraph in the section to parse.

### 9. The difference-of-equations paragraph (lines 1552–1560) is good but the last two sentences are choppy

"This is akin to what makes AIPW preferable to IPW when you use the actual inverse propensity weights $\gamma^{ipw}$. It is the cost of having non-negligible imbalance — but realized entirely as excess variance because it is *mean-zero* non-negligible imbalance. But in this case, compared to the AIPW vs. IPW, it is the *change* in $\mu$-imbalance vs. the $\mu$-imbalance itself."

The back-and-forth ("this is akin to... but... but in this case, compared to...") makes the reader hold too many comparisons in their head at once. The point is sharp: Bernoulli rounding introduces mean-zero imbalance that costs variance just like IPW's imbalance does, except here it's the *change* in imbalance from rounding rather than the total imbalance. Could be one cleaner sentence.

### 10. Remark 7 (line 1630) is very long and dense

This remark covers: (a) the interesting case where weights are in $[0,1]$, (b) when this happens (low treatment probability), (c) the resulting estimator looks like a difference in means from a randomized experiment, (d) the cost relative to using all $N_0$ controls, and (e) the efficiency gain relative to using only $N_1$ controls. That's five ideas in one unbroken paragraph. The efficiency comparison at the end — "reduces asymptotic variance by a factor of $(\rho+1)/\{\rho + \mu_2/\mu_1^2\}$" — arrives without setup and the simplification for equal noise/small propensity is stated but not interpreted. What does this factor *mean*? When is it large vs. small?

### 11. Inconsistency: "BUEI" footnote vs. in-text usage

The footnote at line 1574 says "Having a bounded uniform entropy integral is a probably the most frequently-used sufficient condition" — there's a typo ("a probably") and the footnote reads as an aside rather than a definition. But BUEI is used as a condition throughout. If it's going to be a standing condition, it probably deserves a displayed definition or at least a clean inline one, not just a footnote.

### 12. The closing paragraph (line 1648) is good but could be stronger

"This rounding approach, while reasonable, is not necessarily the best way..." opens a discussion of alternatives (integer programming directly, sparse weighting) but ends with "Sparse weighting ideas like these are an interesting area for future work." This is fine for a synthesis paper, but "interesting area for future work" is a weak closer for a section that has been technically precise throughout. Could the last sentence gesture at *what* would make sparse weighting interesting — e.g., that it could decouple the number of units from the integer constraint?

---

## Summary

The "Doing Better" section has a strong conceptual arc but could use slightly more connective tissue around the modulus of continuity introduction and the approximation condition. The matching section is impressive in scope — rounding, discrepancy theory, efficiency bounds — but the middle stretch (Bernoulli → deterministic → difference decomposition) is the hardest to follow and would benefit from restructuring the logical flow. Remark 7 tries to do too much in one paragraph.
