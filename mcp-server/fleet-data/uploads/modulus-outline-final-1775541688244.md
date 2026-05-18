# Modulus section — paragraph outline

<!-- Goes between "...bounding the deviation of ω from linearity." and the proposition. -->

## Paragraph 1: Centering doesn't change the bias

The key formula. Present as equalities:

$$\text{imbalance}_\mathcal{M}(\hat\gamma) = \omega(s) - s\,\omega'(s) = \xi(s) - s\,\xi'(s)$$

where $\xi(s) = \omega(s) - c \cdot s$ and $c = \lim \omega(s)/s$ (or better: $c = \sup_{m \in \mathcal{M}} \frac{1}{n}\sum_i m(X_i) \cdot \gamma^{\text{ipw}}(X_i)$ — the value the functional takes along the γ^ipw bridge). Subtracting a linear term doesn't change the tangent intercept — the bias is the same whether computed from ω or ξ.

**Why this matters:** ξ is a *centered* version of ω. The centering at γ^ipw makes the population mean of the integrand zero (by the IPW property), turning the supremum into a centered empirical process penalized by a quadratic. This is the object we can bound by localization.

## Paragraph 2: Bounding ξ — the two terms

By concavity and non-negativity of ξ: $\xi(s) - s\,\xi'(s) \le 2\,\xi(s)$. This avoids differentiating the supremum (costs a factor of 2 on a negligible term — irrelevant asymptotically).

Kong/Hirshberg bound ξ(s) by two terms:
- **Offset complexity**: a centered empirical process (same localization as Section 5.2, same fixed-point radius r). Bounded by Cr².
- **Approximation term**: (σ²/n)·B for any competitor g ∈ M with ‖g‖_M ≤ B and ‖g-γ^ipw‖ ≤ ε. Reflects how hard it is to approximate γ^ipw in the model.

Total: ξ(s) ≤ Cr² + (σ²/n)·B. Taking B = Cr²n/σ² (the proposition's condition) gives Cr². For nonparametric models: such B exists for any square-integrable γ^ipw when r → 0. Total = o(n^{-1/2}).

## Paragraph 3: The punchline

The conclusion is stronger than Section 5.2: no augmentation needed. The minimax balancing weights achieve o_p(n^{-1/2}) maximal imbalance without augmentation, without weight convergence. Less smoothing (smaller σ) means better balance.

---

## Notes

- Paragraph 1 is the new content Skip wanted: the centering invariance, connecting ω to ξ
- Paragraph 2 is the mechanism: the two-term bound on ξ
- Paragraph 3 is the existing conclusion (already in line 1343), kept as-is
- The formula in para 1 should be a display equation
- c should be defined precisely (it's the "linear growth rate" of ω — related to the Riesz representer)
