# How the modulus argument actually works {#latest}

<!-- session: paper-editor files: scratch/modulus-proof-sketch.md, bregman-lower-bound.tex:4107-4232 -->

## The proof in four steps

**Step 1: The modulus decomposes.** The penalized modulus $\omega(s) = \sup_{m \in \mathcal{M}} \{ L(m) - \frac{1}{2s}\|m\|^2_{\text{treated}} \}$ can be written as

$$\omega(s) = c \cdot s + \xi(s)$$

where $c$ is a constant (the linear growth rate of $\omega$) and $\xi(s)$ is the **offset complexity** — the deviation from linearity. The decomposition comes from centering the supremum at a specific point related to $\gamma^{\text{ipw}}$.

**Step 2: The bias equals the offset complexity's nonlinearity.** The bias at the optimal weights is $b = \omega(s) - s\omega'(s)$. Substituting the decomposition:

$$b = (cs + \xi(s)) - s(c + \xi'(s)) = \xi(s) - s\xi'(s).$$

The linear part $cs$ cancels completely. The bias depends ONLY on $\xi$ — only on how much the modulus deviates from linearity.

**Step 3: The offset complexity is a centered empirical process.** In the quadratic case, $\xi(s)$ is (approximately):

$$\xi(s) \approx \sup_{h \in \mathcal{M}} \left[ (\hat{P} - P)\{h(X) - W\gamma^{\text{ipw}}(X)h(X)\} - \frac{s}{2}\hat{P}(h^2) \right]$$

The first term is a **centered empirical process**: the function $h(X)(1 - W\gamma^{\text{ipw}}(X))$ has population mean zero by the IPW property $\mathbb{E}[W\gamma^{\text{ipw}}(X)h(X)] = \mathbb{E}[h(X)]$. The second term is a quadratic penalty that kills contributions from large $h$.

**This is where $\gamma^{\text{ipw}}$ enters.** The centering at $\gamma^{\text{ipw}}$ is what makes the empirical process mean-zero. Without it, the process would have a nonzero mean and the offset complexity would be uncontrollable.

**Step 4: Bounding the empirical process by localization.** The centered empirical process is bounded by standard maximal inequalities (Gaussian width/Rademacher complexity) **IF** we can localize — restrict to $h$ near zero. The localization scale is the fixed-point radius $r$.

But the process involves $\gamma^{\text{ipw}}$ through the term $W\gamma^{\text{ipw}}(X)h(X)$. To apply localization within the model, we need $\gamma^{\text{ipw}}$ to be **approximately representable** by functions in $\mathcal{M}$:
- There exists $g \in \mathcal{M}$ with $\|g - \gamma^{\text{ipw}}\|_{L_2} \le Cr^2\sqrt{n}/\sigma$ — the approximation error is small enough that the "leak" $(\gamma^{\text{ipw}} - g) \cdot h$ doesn't dominate the localized empirical process
- And $\|g\|_\mathcal{M} \le Cr^2 n/\sigma^2$ — the approximant stays within the localization scale

When both hold: $\xi(s) \le Cr^2$, so $|b| \le Cr^2$.

## What $\delta$ is (constrained form)

In the constrained formulation, $\delta$ is the constraint radius: $\omega(\delta) = \sup\{|L(m_1) - L(m_2)| : \|m_1 - m_2\|_{\text{treated}} \le \sigma\delta\}$.

$\delta$ and $s$ are linked by the Fenchel-Legendre transform: $\delta = s \cdot \omega'(\delta)$, or equivalently, $s$ is the Lagrange multiplier for the constraint $\|m_1 - m_2\| \le \sigma\delta$.

When we say "the operating point is $\delta_\sigma$," we mean: the balancing weights with tuning $\sigma$ correspond to a modulus parameter $s \sim n/\sigma^2$ (for the quadratic case), and this $s$ maps to a $\delta_\sigma$ through the Legendre relationship.

$\delta_\sigma$ doesn't have a closed-form expression. It's implicitly defined. But its SIZE is controlled by the approximation condition: when $\gamma^{\text{ipw}}$ is well-approximated in the model at scale $(s, r)$, the offset complexity is $\le Cr^2$, which means $\delta_\sigma$ is in the region where $\omega$ is approximately linear.

## Summary: why it works

The modulus is linear when $\gamma^{\text{ipw}}$ is in the model — because $\gamma^{\text{ipw}}$ bridges treated-unit observations to population means, and when this bridge is in the model, the "population mean" functional is just a treated-unit inner product (with $\gamma^{\text{ipw}}$).

The modulus is approximately linear when $\gamma^{\text{ipw}}$ is approximately in the model. The approximation quality, relative to the localization scale $r$ and regularization $\sigma$, determines the bias.

For nonparametric models: the model can approximate any square-integrable $\gamma^{\text{ipw}}$, so the bridge is always approximately in the model. But "approximately" depends on $\sigma$: more regularization (larger $\sigma$, corresponding to smaller $s = n/\sigma^2$) demands a tighter approximation. For any fixed $\sigma$, the approximation improves with $n$, and the bias vanishes.
