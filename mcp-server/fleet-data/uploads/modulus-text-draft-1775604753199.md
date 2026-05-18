## Draft: bound paragraph (replaces lines 1350–1357)

The current text uses the conditional bound (ε ≤ r(δ)) with (σ²/n)·B. Need to switch to the unconditional constrained form: ω(δ) ≤ Cr(δ)² + ε·δ, where B enters only through ε(B).

---

```latex
\citet{kong2025asymptotics} and \citet{hirshberg2026bregman} bound $\omega(\delta)$: if there exists $g \in \model$ with $\norm{g}_\model \le B$ and $\norm{g - \gammaipw}_{L_2(P)} \le \varepsilon$, then
\begin{equation}
\label{eq:omega-bound}
\omega(\delta) \le C\,r(\delta)^2 + \varepsilon\,\delta,
\end{equation}
where $r(\delta)$ is the fixed-point radius satisfying~\eqref{eq:least-squares-fixed-point} at scale~$\delta$. The first term is the local complexity of the model---the same localization as in Section~\ref{sec:role-of-augmentation}. The second is the centering error: $\gammaipw$ is not in the model, so the centered empirical process is not exactly mean-zero, and this costs $\varepsilon\,\delta$. Both terms grow with~$\delta$, so~\eqref{eq:omega-bound} is useful at small~$\delta$ where both are small.

The competitor norm~$B$ enters through the approximation error~$\varepsilon(B) = \inf\{\norm{g - \gammaipw}_{L_2} : g \in \model,\, \norm{g}_\model \le B\}$. Larger~$B$ allows better approximation---smaller~$\varepsilon$---which shrinks the second term and permits the bound to hold at larger~$\delta$. Define $\delta_{\max}(B)$ as the largest~$\delta$ at which~\eqref{eq:omega-bound} stays below~$n^{-1/2}$. Figure~\ref{fig:modulus} (right) plots $\delta_{\max}(B)$ for each model, locating the reader on the left panel: given what you know about your competitor's model norm, here is the range of~$\delta$ at which the bias bound is effective. The Mat\'ern-3/2 model approximates the propensity score easily---$\delta_{\max}$ plateaus at moderate~$B$---while the Gaussian model, whose RKHS is more restrictive, requires much larger~$B$ to reach comparable~$\delta$.
```
