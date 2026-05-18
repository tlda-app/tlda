## What δ\* is and how B enters: clean derivation

### The modulus framework (Armstrong & Kolesár eq. 24)

At operating point δ, the optimal affine estimator has:

$$\text{bias} = \frac{1}{2}\bigl(\omega(\delta) - \delta\,\omega'(\delta)\bigr), \qquad \text{sd} = \sigma\,\omega'(\delta).$$

The bias is the tangent intercept — it grows with δ (ω concave). The sd decreases with δ (ω' decreasing). The optimal δ\* trades these off.

For one-sided CIs: $\delta_\beta = \sigma(z_\beta + z_{1-\alpha}).$

For two-sided CIs: $\delta_\chi = \arg\min_{\delta>0} \text{cv}_\alpha\!\left(\frac{\omega(\delta)}{2\sigma\omega'(\delta)} - \frac{\delta}{2\sigma}\right)\cdot \sigma\omega'(\delta).$

**Key point**: δ\* is determined by σ (the noise level / tuning parameter) and the modulus ω. It is NOT directly a function of B.

---

### Our paper's statement

Equation (donoho-liu-bias):

$$\text{imbalance}_\mathcal{M}(\hat\gamma) = \omega(\delta^*) - \delta^*\,\omega'(\delta^*).$$

This is an equality at a specific δ\*, the operating point of the minimax balancing weights with tuning σ.

Equation (omega-bound): if ∃ g ∈ M with ‖g‖ ≤ B, ‖g − γ^{ipw}‖ ≤ ε, then

$$\omega(\delta) \leq Cr^2 + \varepsilon\delta.$$

Proposition: imbalance ≤ Cr² + εδ\*.

---

### How B enters: two possible stories

**Story A: bounding the bias at a given δ\*.**

Fix δ\* (determined by σ). The bias is $\omega(\delta^*) - \delta^*\omega'(\delta^*) \leq \omega(\delta^*) \leq Cr^2 + \varepsilon(B)\delta^*$.

For this to be ≤ some threshold τ, need $\varepsilon(B) \leq (\tau - Cr^2)/\delta^*$, i.e., $B \geq \varepsilon^{-1}((\tau - Cr^2)/\delta^*)$.

Right panel under Story A: given δ\* (fixed), plot "minimum B needed for bias ≤ τ." But this depends on δ\*, which is a nuisance parameter. Not great for a figure.

**Story B: bounding δ\* itself.**

Is there an oracle inequality that bounds δ\* in terms of ε(B)?

For penalized estimators (tuning σ), the basic inequality gives:

$$\delta^{*2} \leq \inf_{g:\,\|g\|_\mathcal{M}\leq B}\bigl[\|g - \gamma^{ipw}\|_{L_2}^2 + \sigma^2\|g\|_\mathcal{M}^2\bigr] = \varepsilon(B)^2 + \sigma^2 B^2.$$

So $\delta^* \leq \sqrt{\varepsilon(B)^2 + \sigma^2 B^2}$.

This DECREASES then INCREASES in B: at small B, ε(B) is large; at large B, σ²B² dominates. There's a minimizer at the B that balances the two terms.

**But this is the penalized form.** In the constrained form (ω ≤ Cr² + εδ, no σ²B² term), what bounds δ\*?

I'm not sure. The constrained form removes the explicit B penalty, so the bound on δ\* might just be δ\* ≤ ε(B) + r (the approximation error plus the critical radius). But I can't derive this rigorously right now.

---

### What I'm unsure about

1. **Is there a clean bound on δ\* in terms of ε(B) for the constrained parameterization?** I believe so but I can't write it down precisely. This is the gap in my understanding.

2. **Should the right panel show an increasing or decreasing function of B?** Story A gives an increasing δ\_max (larger B → bound valid at larger δ). Story B gives a quantity that depends on both ε(B) and σ²B² (U-shaped in B). These are different things.

3. **What did Skip mean by "the δ at which our linearization error equals the maximum imbalance"?** I still don't have a confident parse of this.

---

### What I need from Skip

A pointer to the specific result (in his paper or Armstrong & Kolesár) that characterizes how δ\* relates to ε(B). The oracle inequality is the natural candidate but I want to make sure I'm using the right version for the constrained parameterization.
