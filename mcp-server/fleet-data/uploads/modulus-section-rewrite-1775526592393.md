# Modulus paragraph rewrite — constrained form

Replaces from "Its central object is the modulus of continuity" through to the proposition (inclusive of the figure and equation). The proposition itself is unchanged.

---

Its central object is the *modulus of continuity* $\omega$, which measures how much the population mean of two functions in the model can differ when their treated-sample predictions are close. Specifically, the modulus is defined as
\FloatBarrier
\begin{figure}[h!]
\centering
\includegraphics[width=0.45\textwidth]{figure/modulus-tangent-line.pdf}
\caption{Modulus of continuity $\omega(\delta)$ (solid) and its tangent line $\omega'(\delta)\,\delta$ (dashed) for two models on the same sample ($n = 500$, $d = 1$). The shaded gap is the bias $\tfrac{1}{2}\{\omega(\delta) - \omega'(\delta)\,\delta\}$. The smoother model (Gaussian RBF, green) has a more linear modulus and smaller bias than the rougher model (Mat\'ern-3/2, blue).}
\label{fig:modulus}
\end{figure}
\begin{equation}
\label{eq:donoho-liu-bias}
\omega(\delta) = \sup\left\{\abs*{\frac{1}{n}\sum_{i=1}^n m_1(X_i) - \frac{1}{n}\sum_{i=1}^n m_2(X_i)} : m_1, m_2 \in \model,\; \smallnorm{m_1 - m_2}_{L_2(\hat P^{W\!=1})} \le \sigma\delta\right\},
\end{equation}
where $\hat P^{W\!=1}$ is the empirical distribution on treated units and $\sigma$ is the tuning parameter in~\eqref{eq_balancing-weights}. Two functions that are hard to distinguish from treated-unit data can still have different population means---the modulus measures the worst case of this discrepancy. In terms of $\omega$, the maximal imbalance of the minimax balancing weights satisfies
\begin{equation}
\label{eq:modulus-bias}
\imbalance_\model(\hgamma) \le \tfrac{1}{2}\left\{\omega(\delta) - \delta\,\omega'(\delta)\right\}.
\end{equation}
The right-hand side is the $y$-intercept of the tangent line to $\omega$ at $\delta$, scaled by $\tfrac{1}{2}$ (Figure~\ref{fig:modulus}). The parameter $\delta$ is determined by how well the inverse propensity weights $\gammaipw$ can be approximated by functions in the model: a function $g \in \model$ that is close to $\gammaipw$ in $L_2$ norm produces a small $\delta$. For nonparametric models (Definition~\ref{def:nonparametric}), such approximations exist for any square-integrable propensity score. A smaller tuning parameter $\sigma$ relaxes the approximation requirement, pushing $\delta$ toward the region where $\omega$ is approximately linear.

When $\omega$ is approximately linear---$\omega(\delta) \approx c\,\delta$ for some constant $c$---the tangent line passes through the origin and the bound~\eqref{eq:modulus-bias} is approximately zero. So bounding the maximal imbalance reduces to bounding the deviation of $\omega$ from linearity. \citet{kong2025asymptotics} and \citet{hirshberg2026bregman} show that this deviation is bounded by $C\,r^2$ for the fixed-point radius $r$ satisfying~\eqref{eq:least-squares-fixed-point}---the same quantity that bounds the error of nonparametric regression in Section~\ref{sec:role-of-augmentation}, and illustrated in Figure~\ref{fig:width-geometry}. The conclusion here is stronger than in that section: there, augmentation with a consistent estimator was needed to convert an $O_p(n^{-1/2})$ bound on maximal imbalance into an $o_p(n^{-1/2})$ bound. Here, the maximal imbalance achieved by the minimax balancing weights is $o_p(n^{-1/2})$.

\begin{proposition}[Maximal imbalance of minimax balancing weights]
\label{prop:bias-balance}
...
\end{proposition}

---

## Notes

- Changed `\omega(s)` → `\omega(\delta)` throughout, including the figure caption.
- The figure caption now says "tangent line" instead of "linearization" and uses the $\tfrac{1}{2}$ factor in the bias expression.
- Used `\abs*{...}` for the absolute value in the modulus definition (auto-sizing). If `\abs*` isn't defined, use `\left\lvert ... \right\rvert` instead.
- Used `\smallnorm{...}_{L_2(\hat P^{W\!=1})}` for the norm in the constraint to keep it from being oversized inside the set builder.
- The $\hat P^{W\!=1}$ notation for the treated empirical distribution may need to match whatever notation is used elsewhere in the paper. Check for consistency.
- The factor of $1/2$ comes from the two-sided (symmetric) modulus: $\omega$ measures the full gap between two functions, but the bias is half that gap.
- Replaced the penalized formulation footnote with inline explanation.
- The proposition is unchanged and follows immediately.
