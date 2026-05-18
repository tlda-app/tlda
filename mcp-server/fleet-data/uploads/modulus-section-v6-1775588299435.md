# Modulus section — v6 (for co-author review) {#latest}

<!-- session: paper-editor. Replaces lines 1331-1343 of main.tex. Figure and proposition unchanged. -->

```latex
The results above establish that balancing weights can beat the true weights, but they do not tell us by how much. There is a long tradition of work on minimax estimation of linear functionals \citep{ibragimov1985nonparametric, donoho1991geometrizing, donoho1994statistical} that studies precisely this kind of problem: estimating a linear functional of an unknown function known to lie in a convex class. Its central object is the \emph{modulus of continuity} $\omega$, which measures how much the population mean of two functions in the model can differ when their predictions on treated units are close:
\FloatBarrier
\begin{figure}[h!]
\centering
\includegraphics[width=0.45\textwidth]{figure/modulus-tangent-line.pdf}
\caption{Modulus of continuity $\omega(\delta)$ (solid) and its linearization $\omega'(\delta)\,\delta$ (dashed) for two models on the same sample ($n = 500$, $d = 1$). The shaded gap is the bias $\tfrac{1}{2}\{\omega(\delta) - \omega'(\delta)\,\delta\}$. The smoother model (Gaussian RBF, green) has a more linear modulus and smaller bias than the rougher model (Mat\'ern-3/2, blue).}
\label{fig:modulus}
\end{figure}
\begin{equation}
\label{eq:donoho-liu-bias}
\omega(\delta) = \sup\left\{\left|\frac{1}{n}\sum_{i=1}^n m_1(X_i) - \frac{1}{n}\sum_{i=1}^n m_2(X_i)\right| : m_1, m_2 \in \model,\; \norm{m_1 - m_2}_{L_2(\hat P^{W\!=1})} \le \sigma\delta\right\}.
\end{equation}
The constraint measures similarity on treated units; the objective measures the discrepancy in population means. Two functions can look alike on the treated sample yet have different means across all units---the modulus captures the worst case. In terms of $\omega$, the maximal imbalance of the minimax balancing weights satisfies
\begin{equation}
\label{eq:modulus-bias}
\imbalance_\model(\hgamma) = \tfrac{1}{2}\bigl\{\omega(\delta_\sigma) - \delta_\sigma\,\omega'(\delta_\sigma)\bigr\},
\end{equation}
the $y$-intercept of the tangent line to $\omega$ at the estimator's operating point $\delta_\sigma$ (Figure~\ref{fig:modulus}). When $\omega$ is approximately linear---$\omega(\delta) \approx c\,\delta$---the tangent line passes near the origin and the bias is small. So bounding the maximal imbalance reduces to bounding the deviation of $\omega$ from linearity.

\citet{kong2025asymptotics} and \citet{hirshberg2026bregman} bound this deviation by two terms. The first is the \emph{offset complexity}, which is controlled by the local complexity of the model at the fixed-point radius $r$ satisfying~\eqref{eq:least-squares-fixed-point}---the same quantity and the same localization mechanism as in Section~\ref{sec:role-of-augmentation}. It is bounded by $C\,r^2$. The second is a subgradient term proportional to $(\sigma^2/n)\,\norm{\tilde\phi}_\model$, where $\tilde\phi$ is the population solution to the dual problem~\eqref{eq:dual_l2_penalized_regression}---a penalized least squares estimate of $\gammaipw$. This term reflects how complex the model function approximating $\gammaipw$ needs to be: if $\gammaipw$ requires a function of large model norm to approximate, this term is large. A competitor bound controls it: for any $g \in \model$ approximating $\gammaipw$ with $\norm{g}_\model \le B$, the subgradient term is at most $C\,\sigma^2 B / n$. Taking $B = C\,r^2 n/\sigma^2$---feasible for nonparametric models whenever $\gammaipw$ is square-integrable---gives $C\,r^2$, the same order as the offset complexity. The total bound is $C\,r^2 = o_p(n^{-1/2})$, and the conclusion is stronger than in Section~\ref{sec:role-of-augmentation}: there, augmentation with a consistent estimator was needed for an $o_p(n^{-1/2})$ bound; here, the minimax balancing weights achieve it without augmentation.
```
