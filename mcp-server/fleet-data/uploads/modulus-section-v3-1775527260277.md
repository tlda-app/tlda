# Modulus paragraph v3 — constrained form

Replaces from "Its central object is the *modulus of continuity*" through the linearity/deviation paragraph, ending just before `\begin{proposition}`. The figure and proposition are unchanged.

---

Its central object is the *modulus of continuity* $\omega(\delta)$, which measures the largest difference in population means between two functions in the model whose treated-sample predictions differ by at most $\sigma\delta$ in $L_2$ norm:
\FloatBarrier
\begin{figure}[h!]
\centering
\includegraphics[width=0.45\textwidth]{figure/modulus-tangent-line.pdf}
\caption{Modulus of continuity $\omega(\delta)$ (solid) and its linearization $\omega'(\delta)\,\delta$ (dashed) for two models on the same sample ($n = 500$, $d = 1$). The shaded gap is the bias $\tfrac{1}{2}\{\omega(\delta) - \omega'(\delta)\,\delta\}$. The smoother model (Gaussian RBF, green) has a more linear modulus and smaller bias than the rougher model (Mat\'ern-3/2, blue).}
\label{fig:modulus}
\end{figure}
\begin{equation}
\label{eq:constrained-modulus}
\omega(\delta) = \sup\left\{\frac{1}{n}\sum_{i=1}^n m_1(X_i) - \frac{1}{n}\sum_{i=1}^n m_2(X_i) \;:\; m_1, m_2 \in \model,\; \norm{m_1 - m_2}_{L_2(\hat P^{W\!=1})} \le \sigma\delta\right\},
\end{equation}
where $\hat P^{W\!=1}$ is the empirical distribution on treated units and $\sigma$ is the tuning parameter in~\eqref{eq_balancing-weights}.\footnote{This is the constrained formulation of \citet{donoho1994statistical} and \citet{armstrong2018optimal}; it is equivalent by Lagrangian duality to a penalized formulation. See Appendix~\ref{app:modulus-equivalence}.} In terms of $\omega$, the maximal imbalance of the minimax balancing weights satisfies
\begin{equation}
\label{eq:donoho-liu-bias}
\imbalance_\model(\hgamma) = \tfrac{1}{2}\bigl\{\omega(\delta_\sigma) - \delta_\sigma\,\omega'(\delta_\sigma)\bigr\},
\end{equation}
the $y$-intercept of the tangent line to $\omega$ at a point $\delta_\sigma$ determined by how well functions in the model can approximate the inverse propensity weights $\gammaipw$ (Figure~\ref{fig:modulus}). Because $\omega$ is concave with $\omega(0) = 0$, it is most linear near the origin and curves away as $\delta$ grows. Good approximation of $\gammaipw$---a function $g \in \model$ close to $\gammaipw$ in $L_2$ norm---places $\delta_\sigma$ near the origin, where $\omega(\delta) \approx c\,\delta$ and the right-hand side of~\eqref{eq:donoho-liu-bias} is approximately zero. For nonparametric models (Definition~\ref{def:nonparametric}), any square-integrable $\gammaipw$ can be approximated to arbitrary precision, so $\delta_\sigma$ is automatically in this near-linear region. Bounding the maximal imbalance therefore reduces to bounding the deviation of $\omega$ from linearity. \citet{kong2025asymptotics} and \citet{hirshberg2026bregman} show that this deviation is bounded by $C\,r^2$ for the fixed-point radius $r$ satisfying~\eqref{eq:least-squares-fixed-point}---the same quantity that bounds the error of nonparametric regression in Section~\ref{sec:role-of-augmentation}, and illustrated in Figure~\ref{fig:width-geometry}. The conclusion here is stronger than in that section: there, augmentation with a consistent estimator was needed to convert an $O_p(n^{-1/2})$ bound on maximal imbalance into an $o_p(n^{-1/2})$ bound. Here, the maximal imbalance achieved by the minimax balancing weights is $o_p(n^{-1/2})$.
