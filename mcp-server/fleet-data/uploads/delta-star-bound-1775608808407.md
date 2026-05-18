## Bounding δ\* through approximability

**Setup.** The bias is ω(δ\*) − δ\*ω′(δ\*), which grows with δ\*. So we want δ\* small. We need an upper bound on δ\*.

**What determines δ\*?** The operating point δ\* is the value of δ at which the minimax balancing weights solve their optimization. For the penalized problem with tuning parameter σ, δ\* is determined by the KKT conditions — roughly, δ\* is the L₂ norm of the weight error on treated units. The key fact: δ\* satisfies

$$\delta^* \leq \inf_{g \in \mathcal{M},\, \|g\|_{\mathcal{M}} \leq B} \|g - \gamma^{ipw}\|_{L_2(\hat{P}^{W=1})} + r$$

where r is the critical radius. (This is the "basic inequality" flavor: the operating point can't be much larger than the approximation error plus the statistical noise.) So:

$$\delta^* \leq \varepsilon(B) + r$$

where $\varepsilon(B) = \inf\{\|g - \gamma^{ipw}\|_{L_2} : g \in \mathcal{M},\, \|g\|_{\mathcal{M}} \leq B\}$.

**Wait — is this right?** I'm not sure this is the correct bound on δ\*. The operating point in the Donoho–Liu theory comes from the intersection of the modulus curve with a constraint set, not from a basic inequality. Let me think about this differently.

---

**Alternative: δ\* from the modulus directly.**

In the Donoho–Liu framework, δ\* is characterized by the tangent line to ω at δ\* passing through a specific point related to the variance. The operating point satisfies:

$$\omega'(\delta^*) = \frac{\omega(\delta^*)}{2\delta^*} + \frac{\text{something involving variance}}{2\delta^*}$$

This is model-specific and hard to compute in closed form. 

---

**What the right panel should show.**

What we actually know: given a competitor g with $\|g\|_{\mathcal{M}} \leq B$ and $\|g - \gamma^{ipw}\| \leq \varepsilon$, the bound says $\omega(\delta) \leq Cr^2 + \varepsilon\delta$ for all δ.

The bias at operating point δ\* is $\leq \omega(\delta^*) \leq Cr^2 + \varepsilon\delta^*$.

So for the bias to be $\leq n^{-1/2}$, it suffices that $Cr^2 + \varepsilon\delta^* \leq n^{-1/2}$, i.e.,

$$\delta^* \leq \frac{n^{-1/2} - Cr^2}{\varepsilon(B)}$$

Call the right-hand side $\delta_{\max}(B)$. This is the largest δ\* at which the bound certifies the bias is below $n^{-1/2}$.

**Properties:**
- $\delta_{\max}(B)$ is increasing in B (because ε(B) is decreasing)
- If $Cr^2 \geq n^{-1/2}$, then $\delta_{\max} \leq 0$ — the model is too complex for the sample size, the bound can't help
- As $B \to \infty$, $\varepsilon(B) \to 0$ (for nonparametric models), so $\delta_{\max} \to \infty$

**To compute this, we need Cr².** The critical radius r satisfies the fixed-point equation. For an RKHS with kernel eigenvalues $\lambda_1 \geq \lambda_2 \geq \cdots$, r solves approximately:

$$\sum_j \min\!\left(\frac{\lambda_j}{r^2}, 1\right) \approx n r^2$$

(up to constants). This can be solved numerically from the eigenvalues we already have.

**The constant C** is a universal constant from the concentration inequality (typically absorbed into the ≈). For the figure, we could calibrate C by matching the bound to the actual ω at a reference δ: find C such that $Cr^2 + \varepsilon_0 \cdot \delta_0 = \omega(\delta_0)$ for some reference point.

---

**Summary.** The right panel should plot:

$$\delta_{\max}(B) = \frac{n^{-1/2} - Cr^2}{\varepsilon(B)}$$

This requires:
1. ε(B) — already computed via eigendecomposition + ridge (the `compute_eps_B_curve` function)
2. r — solve the fixed-point equation from the kernel eigenvalues  
3. C — calibrate from the actual ω, or use C = 1 as a rough approximation
