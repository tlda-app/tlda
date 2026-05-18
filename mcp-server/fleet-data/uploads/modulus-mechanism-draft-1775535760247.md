# Modulus mechanism paragraphs — modulus-writer draft {#latest}

<!-- 
session: modulus-writer
files: main.tex:1331-1351, bregman-lower-bound.tex:3988-4067,4128-4370
task: 2-3 paragraphs between line 1343 ("...bounding the deviation of ω from linearity.") and the proposition (line 1345). Do NOT rewrite existing setup.
-->

These paragraphs **replace** the current text from `\citet{kong2025asymptotics}` through the end of line 1343 (before the proposition). The text before — ω definition, bias = tangent intercept, "when ω is approximately linear the bias is small," "bounding the deviation of ω from linearity" — is unchanged.

```latex
\citet{kong2025asymptotics} and \citet{hirshberg2026bregman} show how to bound this deviation. Write $\omega(s) = c \cdot s + \xi(s)$, separating the modulus into a linear part $c \cdot s$ and a non-negative remainder $\xi(s)$, the \emph{offset complexity}. The constant $c$ depends on the inverse propensity weights $\gammaipw$: when $\gammaipw$ is representable within the model, the modulus is exactly linear and $\xi = 0$. The linear part does not contribute to the gap between $\omega$ and its tangent line (Figure~\ref{fig:modulus}), so the bias depends only on $\xi$. Bounding the bias reduces to bounding the offset complexity.

The offset complexity is controlled by two terms. The first is the supremum of a centered empirical process penalized by a quadratic---the same ``correlation with noise'' structure as in the regression fixed-point argument~\eqref{eq:least-squares-fixed-point} and illustrated in Figure~\ref{fig:width-geometry}. The centering is at $\gammaipw$, which makes each term mean-zero by the population balance property~\eqref{eq_mipw-balance}, and the quadratic penalty localizes the supremum to a ball of radius $r$ around the origin. By the same fixed-point reasoning as in Section~\ref{sec:role-of-augmentation}, this empirical process term is bounded by $C\,r^2$. The second term reflects how well $\gammaipw$ can be approximated in the model. For any competitor $g \in \model$ approximating $\gammaipw$ with model norm $\norm{g}_\model \le B$ and $L_2$ error $\norm{g - \gammaipw}_{L_2(P)} \le \varepsilon$, this approximation term is at most $C\,\sigma^2 B/n$. The norm bound $B$ governs how far into the model we must reach to find $g$; the $L_2$ bound $\varepsilon$ ensures the competitor is close enough that the approximation error does not leak back into the empirical process.

Taking $B = C\,r^2 n/\sigma^2$ and $\varepsilon = C\,r^2 \sqrt{n}/\sigma$ gives an approximation term of order $r^2$, matching the empirical process term. These are the two conditions on the competitor $g$ in Proposition~\ref{prop:bias-balance}. For nonparametric models (Definition~\ref{def:nonparametric}), such a competitor exists for any square-integrable $\gammaipw$ whenever $r \to 0$: the model can approximate any $L_2$ function, and the bounds $B$ and $\varepsilon$ grow with $n$, so the requirements on the competitor become easier to meet as the sample grows. The total bound is $C\,r^2 = o_p(n^{-1/2})$, and the conclusion is stronger than in Section~\ref{sec:role-of-augmentation}: there, augmentation with a consistent estimator was needed to convert an $O_p(n^{-1/2})$ bound on maximal imbalance into an $o_p(n^{-1/2})$ bound. Here, the minimax balancing weights achieve it without augmentation.
```
