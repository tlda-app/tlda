# Section 5 restructure proposal

## Current structure

**5.1 Comparing to the true inverse propensity weights** — plug-in comparison, bounding imbalance by comparing to $\gamma^{ipw}$

**5.2 The role of augmentation** — equicontinuity, symmetrization, connection to regression, local complexity / fixed-point

**5.3 The inner product perspective** — bias as inner product of errors, Cauchy-Schwarz / rate double robustness, orthogonality from first-order conditions, optimal double robustness, remark on reversed orthogonality

**5.4 Doing Better than the True Weights** — AIPW variance advantage, beating true weights, modulus of continuity, fixed-point bound on imbalance, in-sample vs out-of-sample, RKHS remark, augmentation remark

## Problems

1. **5.4 is overloaded** — 8 ideas in one subsection
2. **5.3 is a mixed bag** — it starts with a different perspective on bias (inner product), which is useful, but then the optimal double robustness material is a distinct result that could stand on its own
3. **The modulus material in 5.4 is the payoff of the whole section** but it's buried as one of many items in 5.4
4. **The narrative arc gets lost**: 5.1 (plug-in) → 5.2 (augmentation helps) → 5.3 (inner product gives sharper view) → 5.4 (you can beat true weights entirely). The arc is good but 5.3 and 5.4 each try to do too much.

## Proposed restructure

**5.1 Comparing to the true inverse propensity weights** — *unchanged*

**5.2 The role of augmentation** — *unchanged* (equicontinuity, regression connection, local complexity)

**5.3 Doing better than the true weights** — the current 5.4, but trimmed:
- AIPW variance advantage with true weights
- Beating true weights (paradox + explanation)
- Sieve/RKHS/Hirano results
- Modulus of continuity (penalized form, bias formula, linearity punchline)
- Fixed-point bound on imbalance (Proposition)
- "These ARE the right measures" paragraph
- Contrast with weight convergence approach
- In-sample vs out-of-sample figure
- RKHS remark
- Augmentation remark

This is still a lot, but the narrative is a single thread: true weights aren't optimal → modulus quantifies the gap → local complexity controls it → in-sample advantage. Each piece follows from the previous.

**5.4 The inner product perspective** — the current 5.3, positioned as a complementary viewpoint rather than part of the main arc:
- Bias as inner product of errors
- Cauchy-Schwarz / rate double robustness
- Orthogonality from first-order conditions
- Remark on reversed orthogonality

**5.5 Optimal double robustness** — the paragraph from current 5.3 about optimal DR, expanded slightly:
- What optimal DR means (efficient inference when *either* nuisance is smooth)
- Why this is optimal (Mukherjee/Robins lower bound)
- Connection to balancing weights (Hirshberg/Kennedy)

Alternatively, optimal double robustness could remain a remark within 5.4 (the inner product section) rather than its own subsection. Skip mentioned "optimal double robustness as a later section along with the other shit" — this could be 5.5 or could be absorbed into a remark.

## Trade-off

The main question is whether the inner product perspective (current 5.3) should come before or after "doing better" (current 5.4).

**Before** (current order): the inner product gives a more refined view of bias that sets up "doing better." The Cauchy-Schwarz / orthogonality analysis is a bridge.

**After** (proposed): the main narrative flows more directly: plug-in → augmentation → beating true weights (the climax). The inner product perspective is then a complementary lens, not a prerequisite.

I lean toward **after**, because the modulus/fixed-point material in "Doing Better" doesn't depend on the inner product section at all. The inner product section's main reference forward is to the RKHS results mentioned in 5.4, which is a citation not a logical dependency.
