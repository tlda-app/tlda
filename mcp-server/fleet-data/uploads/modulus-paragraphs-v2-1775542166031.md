# Modulus section paragraphs — v2

<!-- 
Goes after "...bounding the deviation of ω from linearity." 
Before the proposition.
Uses CONSTRAINED modulus (the live version).
-->

```latex
\citet{kong2025asymptotics} and \citet{hirshberg2026bregman} show how to bound this deviation. Write $\omega(\delta) = c\,\delta + \xi(\delta)$, where $c$ is the linear growth rate of $\omega$---the rate at which it would grow if $\gammaipw$ were exactly representable in the model---and $\xi(\delta) \ge 0$ is the \emph{offset complexity}, measuring the deviation. When $\gammaipw$ is in the model, the model can bridge treated-unit observations to the full-sample mean, so two functions that are close on treated units cannot differ much in their means: $\omega$ is exactly linear and $\xi = 0$. When $\gammaipw$ is not in the model, the bridge is imperfect, and the gap $\xi$ is what we need to control. Subtracting the linear part does not change the tangent intercept, so the bias depends only on $\xi$: bounding it reduces to bounding the offset complexity.

\citet{hirshberg2026bregman} bounds $\xi(\delta)$ by two terms. The first is the local complexity of the model at the fixed-point radius $r$ satisfying~\eqref{eq:least-squares-fixed-point}---the same object and the same localization as in Section~\ref{sec:role-of-augmentation}, bounded by $C\,r^2$. The second is an approximation term: for any competitor $g \in \model$ with $\norm{g}_\model \le B$ and $\norm{g - \gammaipw}_{L_2(P)} \le \varepsilon$, this term is at most $C\,\sigma^2 B/n$. It reflects how well $\gammaipw$ can be approximated in the model: the larger the model norm $B$ required for a good approximation, the larger this term. For negligibility---the approximation term being $o(n^{-1/2})$---it suffices that \emph{some} $g$ in the model approximates $\gammaipw$ at finite model norm, which is automatic for nonparametric models whenever $\gammaipw$ is square-integrable. To match the local complexity rate $C\,r^2$, the stronger condition $B \le C\,r^2 n / \sigma^2$ is needed; this is the approximation condition in Proposition~\ref{prop:bias-balance}. When both terms are $O(r^2)$, the total is $C\,r^2 = o_p(n^{-1/2})$, and the conclusion is stronger than in Section~\ref{sec:role-of-augmentation}: there, augmentation with a consistent estimator was needed to convert an $O_p(n^{-1/2})$ bound on maximal imbalance into an $o_p(n^{-1/2})$ bound. Here, the minimax balancing weights achieve it without augmentation.
```
