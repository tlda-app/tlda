# Modulus section rewrite — v4 {#latest}

<!-- session: paper-editor files: scratch/modulus-section-v4.md, main.tex:1331-1351 -->

<span style="color: mediumpurple">**Claude**</span>: Picking up from the bact thread. The core problem: the text defines $\omega$ and states the bias formula but never says what $\delta$ is. The reader sees a free parameter and can't locate themselves on the curve. Bact kept writing "determined by approximation quality" without explaining what that means. Here's my attempt.

Replaces from "The results above establish..." (line 1331) through the end of the paragraph before `\begin{proposition}` (line 1343). The figure and proposition are unchanged.

---

## Draft text

The results above establish that balancing weights can beat the true weights, but they do not tell us by how much. There is a long tradition of work on minimax estimation of linear functionals \citep{ibragimov1985nonparametric, donoho1991geometrizing, donoho1994statistical} that studies precisely this kind of problem: estimating a linear functional of an unknown function known to lie in a convex class. Its central object is the *modulus of continuity*

$$\omega(\delta) = \sup\left\{\left|\frac{1}{n}\sum_{i=1}^n m_1(X_i) - \frac{1}{n}\sum_{i=1}^n m_2(X_i)\right| : m_1, m_2 \in \mathcal{M},\; \|m_1 - m_2\|_{L_2(\hat P^{W=1})} \le \sigma\delta\right\},$$

which measures how much the population mean of two functions in the model can differ when their predictions on treated units are within $\sigma\delta$ of each other in $L_2$ norm. The maximal imbalance of the minimax balancing weights is

$$\text{imbalance}_\mathcal{M}(\hat\gamma) = \tfrac{1}{2}\{\omega(\delta_\sigma) - \delta_\sigma\,\omega'(\delta_\sigma)\},$$

the $y$-intercept of the tangent line to $\omega$ at a point $\delta_\sigma$ that depends on the propensity score and the model. Because $\omega$ is concave with $\omega(0) = 0$, its tangent line at the origin passes through the origin — meaning zero bias — and the tangent line's $y$-intercept grows as $\delta$ moves away from the origin (Figure~\ref{fig:modulus}).

The question is where $\delta_\sigma$ falls. It is determined by how well the inverse propensity weights $\gamma^{\text{ipw}}$ can be approximated by functions in the model $\mathcal{M}$: if there is a function $g \in \mathcal{M}$ that is close to $\gamma^{\text{ipw}}$ in $L_2$ norm and has moderate model complexity, $\delta_\sigma$ is near the origin. What "close" and "moderate" mean depends on the sample size and the tuning parameter: a larger $n$ or smaller $\sigma$ relaxes both requirements, because there is more data to distinguish functions or less regularization restricting the approximation. For a nonparametric model (Definition~\ref{def:nonparametric}), any square-integrable $\gamma^{\text{ipw}}$ can be approximated to arbitrary precision, so $\delta_\sigma$ is in the near-linear region of $\omega$ regardless of the form of the propensity score. The form of the propensity score affects only the rate — how quickly $\delta_\sigma$ approaches the origin as $n$ grows — not whether the bias vanishes.

Bounding the maximal imbalance therefore reduces to bounding the deviation of $\omega$ from linearity. \citet{kong2025asymptotics} and \citet{hirshberg2026bregman} show that this deviation is bounded by $C\,r^2$ for the fixed-point radius $r$ satisfying~\eqref{eq:least-squares-fixed-point} — the same quantity that bounds the error of nonparametric regression in Section~\ref{sec:role-of-augmentation}, and illustrated in Figure~\ref{fig:width-geometry}. The conclusion here is stronger than in that section: there, augmentation with a consistent estimator was needed to convert an $O_p(n^{-1/2})$ bound on maximal imbalance into an $o_p(n^{-1/2})$ bound. Here, the maximal imbalance achieved by the minimax balancing weights is $o_p(n^{-1/2})$.

---

## <span style="color: mediumpurple">**Claude**</span> notes

**What changed from current text:**
- Switched from penalized to constrained modulus (matching Armstrong/Donoho)
- Bias formula is now equality with $\frac{1}{2}$ factor (two-sided modulus)
- $s$ → $\delta_\sigma$ throughout
- New paragraph explaining WHAT determines $\delta_\sigma$: approximation quality of $\gamma^{\text{ipw}}$ in the model, with concrete discussion of what makes it small (larger $n$, smaller $\sigma$, richer model)
- Nonparametric punchline: $\delta_\sigma$ is in the good region regardless of propensity score form; form only affects rate

**What I'm unsure about:**
1. The $L_2$ norm — should it be $\hat P^{W=1}$ (treated only) or $P_n$ (all units)? The Armstrong framework uses treated only (through the observation operator $K$), but earlier discussions flagged this as unresolved.
2. Whether the penalized/constrained duality footnote is still needed or if the inline mention is enough
3. The figure caption needs updating ($s$ → $\delta$, add $\frac{1}{2}$ factor) — I haven't included that here
4. Whether "moderate model complexity" is concrete enough or if the actual condition ($\|g\|_\mathcal{M} \le Cr^2 n/\sigma^2$) should be stated inline (vs. only in the proposition)
