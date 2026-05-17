# Modulus: general → specialized

## Step 1: General notation (Section 6 / Bregman paper)

In the general framework, the target functional is $\psi(m) = \frac{1}{n}\sum_i h(W_i, X_i, m)$ and the pairing is $\langle\gamma, m\rangle = \frac{1}{n}\sum_i \gamma(W_i, X_i)m(W_i, X_i)$. The imbalance is (eq generalizations):

$$\text{imbalance}_{h,\mathcal{M}}(\hat\gamma) = \max_{m \in \mathcal{M}} \left|\frac{1}{n}\sum_i \hat\gamma(W_i, X_i)m(W_i, X_i) - \frac{1}{n}\sum_i h(W_i, X_i, m)\right|$$

The Bregman paper's modulus in this notation, for quadratic dispersion:

$$\omega(s) = \sup_{m \in \mathcal{M}} \left\{\frac{1}{n}\sum_i h(W_i, X_i, m) - \frac{1}{2sn}\sum_i m(W_i, X_i)^2\right\}$$

## Step 2: Specialize to $\psi_1$

The substitution (line 1441–1443): $\gamma_\psi(W_i, X_i) = W_i\gamma^{ipw}(X_i)$, and $h(W_i, X_i, m) = \mu_1(X_i) = m(X_i)$.

But $m$ in the model $\mathcal{M}$ is a function of $X$ only, so $m(W_i, X_i) = m(X_i)$.

Substituting:

$$\omega(s) = \sup_{m \in \mathcal{M}} \left\{\frac{1}{n}\sum_i m(X_i) - \frac{1}{2sn}\sum_i m(X_i)^2\right\}$$

Both sums over all $i$.

## What confuses me

Skip says "the functional is not all units." But $h(W_i, X_i, m) = m(X_i)$ for $\psi_1$, so $\frac{1}{n}\sum_i h(W_i, X_i, m) = \frac{1}{n}\sum_i m(X_i)$ — all units. This matches the Bregman paper's $\hat{P}\dot\psi_Z(m) = \frac{1}{n}\sum_i m(X_i)$ for $\psi_1$.

Unless: the functional should NOT be specialized to $\psi_1$? Maybe the modulus should stay in the general notation with $h(W_i, X_i, m)$?
