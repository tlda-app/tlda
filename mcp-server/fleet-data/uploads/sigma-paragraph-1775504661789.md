# Paragraph after figure — $\sigma$ scaling

Goes after the current paragraph ending "...the advantage that cross-fitting, which evaluates weights on held-out data, cannot access."

## Draft

The upward shift of the tradeoff regime with $n$ in Figure~\ref{fig:insample-outsample} reflects the distinction between in-sample and out-of-sample balance. In-sample balance improves as $\sigma$ shrinks, because smaller $\sigma$ gives the weights more freedom to match the sample. Out-of-sample balance, by contrast, requires the weights to estimate the inverse propensity score function, and the rate-optimal regularization for this estimation grows with $n$: taking $\sigma \propto \sqrt{n}\, r$ for the fixed-point radius $r$ gives the minimax rate of convergence for the weight function \citep[Section~3.3]{hirshberg2021augmented}. Because $r \to 0$ slower than $n^{-1/2}$, $\sigma^2 \propto n r^2$ grows with $n$. This means that tuning for in-sample balance is forgiving — any sufficiently small $\sigma$ works — while tuning for out-of-sample balance targets a moving window whose location depends on both the sample size and the model.
