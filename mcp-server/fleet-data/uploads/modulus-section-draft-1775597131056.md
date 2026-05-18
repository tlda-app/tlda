## Draft: modulus section (lines 1331–1365)

Changes from current:
- **σ dropped from modulus constraint**: `≤ δ` instead of `≤ σδ`
- **Operating point**: `δ^*` instead of `δ_σ` (still depends on σ, but the modulus itself doesn't)
- **Figure include**: single combined PDF at full width
- **Caption**: matches actual figure (Matérn-5/2, δ_max(B) right panel)
- **Line 1357**: right panel reference updated to δ_max story
- **Text flavor**: left panel is pure geometry (no σ), right panel is the translation (σ enters)

---

### Lines 1331–1341 (intro through bias equation)

```latex
The results above establish that balancing weights can beat the true weights, but they do not tell us by how much. There is a long tradition of work on minimax estimation of linear functionals \citep{ibragimov1985nonparametric, donoho1991geometrizing, donoho1994statistical} that studies precisely this kind of problem: estimating a linear functional of an unknown function known to lie in a convex class. Its central object is the \emph{modulus of continuity} $\omega$, which we define centered at $\gammaipw$:\footnote{Centering at $\gammaipw$ does not change the tangent intercept: it subtracts a linear term, which cancels. The uncentered version used by \citet{donoho1994statistical} and \citet{armstrong2018optimal} gives the same bias. See Appendix~\ref{app:modulus-equivalence}.}
\begin{equation}
\label{eq:offset-complexity}
\omega(\delta) = \sup\left\{ \left|\frac{1}{n}\sum_{i=1}^n \{1 - W_i \gammaipw(X_i)\}\, (m_1 - m_2)(X_i) \right| : m_1, m_2 \in \model,\, \norm{m_1 - m_2}_{L_2(\hat P^{W\!=1})} \le \delta \right\}.
\end{equation}
Because $\E[\{1 - W_i \gammaipw(X_i)\}\, m(X_i)] = 0$ by the population balance property~\eqref{eq_mipw-balance}, the integrand is mean-zero: $\omega$ measures how much a centered empirical process can fluctuate over functions that are close on treated units. The maximal imbalance of the minimax balancing weights satisfies
\begin{equation}
\label{eq:donoho-liu-bias}
\imbalance_\model(\hgamma) = \omega(\delta^*) - \delta^*\,\omega'(\delta^*),
\end{equation}
the $y$-intercept of the tangent line to $\omega$ at the estimator's operating point $\delta^*$ (Figure~\ref{fig:modulus}, left). When $\gammaipw$ is in the model, $\omega = 0$ and the bias vanishes. When it is not, bounding the bias reduces to bounding~$\omega$.
```

### Lines 1342–1350 (figure)

```latex
\FloatBarrier
\begin{figure}[h!]
\centering
\includegraphics[width=\textwidth]{figure/modulus-tangent-line.pdf}
\caption{\emph{Left:} Modulus of continuity $\omega(\delta)$ (solid) and its linearization $\omega'(\delta)\,\delta$ (dashed) for two Mat\'ern models on the same sample ($n = 500$, $d = 1$). The shaded gap is the bias $\omega(\delta) - \omega'(\delta)\,\delta$. The smoother model (Mat\'ern-5/2, green) has a more linear modulus and smaller bias than the rougher model (Mat\'ern-3/2, blue). \emph{Right:} For each model, the largest imbalance budget~$\delta_{\max}$ at which the bound~\eqref{eq:omega-bound} stays below two standards---matching the local complexity rate~$C\,r^2$ (solid) and negligibility at~$\frac{1}{2}n^{-1/2}$ (dashed)---as a function of the competitor model norm~$B$. A reader who knows their competitor's norm reads off the~$\delta$ range they occupy on the left panel.}
\label{fig:modulus}
\end{figure}
```

### Lines 1352–1357 (bound paragraph)

```latex
\citet{kong2025asymptotics} and \citet{hirshberg2026bregman} bound $\omega(\delta)$: if there exists $g \in \model$ with $\norm{g}_\model \le B$ and $\norm{g - \gammaipw}_{L_2(P)} \le \varepsilon \le r(\delta)$, then
\begin{equation}
\label{eq:omega-bound}
\omega(\delta) \le C\,r(\delta)^2 + \frac{\sigma^2}{n}\,B,
\end{equation}
where $r(\delta)$ is the fixed-point radius satisfying~\eqref{eq:least-squares-fixed-point} at scale~$\delta$. The first term is the local complexity of the model---the same localization as in Section~\ref{sec:role-of-augmentation}, illustrated in Figure~\ref{fig:width-geometry}. The second is the approximation cost: the model norm of the competitor~$g$ times $\sigma^2/n$. The condition $\varepsilon \le r(\delta)$ asks only that the approximation be close enough to fall within the localization radius---when it does, the centering error is absorbed into the local complexity. Figure~\ref{fig:modulus} (right) maps the competitor norm~$B$ to the largest~$\delta$ at which the bound stays below each standard, locating the reader on the left panel.
```

### Lines 1359 (two standards paragraph) — unchanged except δ_σ → δ*

No changes needed here — this paragraph doesn't reference δ_σ.

### Proposition (lines 1361–1365) — unchanged

No δ_σ references.
