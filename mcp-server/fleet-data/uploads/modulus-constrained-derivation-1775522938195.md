# Constrained modulus — Armstrong specialization to our setting

## Armstrong's framework (eq 1, 3 of Armstrong & Kolesár 2018)

Observe $Y = Kf + \sigma\varepsilon$ where $f \in \mathcal{F}$ convex, $K$ linear, $\varepsilon$ standard Gaussian. The modulus:

$$\omega(\delta) = \sup\{Lg - Lf : \|K(g-f)\| \le \delta,\; f,g \in \mathcal{F}\}$$

The minimax affine estimator $\hat{L}_\delta$ has:
- **Bias**: $\frac{1}{2}(\omega(\delta) - \delta\omega'(\delta))$
- **Standard deviation**: $\sigma\omega'(\delta)$

## Mapping to our setting

For estimating $\psi_1 = \frac{1}{n}\sum_i \mu_1(X_i)$ with model $\mathcal{M}$:

- $f = \mu_1$ (the conditional mean under treatment)
- $\mathcal{F} = \mathcal{M}$ (the model)
- $L(f) = \frac{1}{n}\sum_i f(X_i)$ (the target functional)
- $K(f) = \left(\frac{f(X_i)}{\sigma_i}\right)_{i: W_i=1}$ (observations on treated units, scaled by noise)
- For constant noise $\sigma_i = \sigma$: $\|K(g-f)\| = \frac{1}{\sigma}\|g-f\|_{L_2(P_n^{W=1})}$ where $P_n^{W=1}$ is the empirical distribution on treated units

So the constrained modulus in our notation:

$$\omega(\delta) = \sup\left\{\left|\frac{1}{n}\sum_i m_1(X_i) - \frac{1}{n}\sum_i m_2(X_i)\right| : m_1, m_2 \in \mathcal{M},\; \frac{\|m_1-m_2\|_{L_2(P_n^{W=1})}}{\sigma} \le \delta\right\}$$

Or absorbing $\sigma$ into $\delta$ (set $\delta' = \sigma\delta$):

$$\bar\omega(\delta') = \sup\left\{\left|\frac{1}{n}\sum_i m_1(X_i) - \frac{1}{n}\sum_i m_2(X_i)\right| : m_1, m_2 \in \mathcal{M},\; \|m_1-m_2\|_{L_2(P_n^{W=1})} \le \delta'\right\}$$

## Bias formula

$$\text{bias} = \frac{1}{2}\left(\omega(\delta) - \delta\omega'(\delta)\right)$$

Same tangent-intercept formula. The $1/2$ comes from the two-sided modulus.

## What $\delta$ is

$\delta$ is chosen to optimize the bias-variance tradeoff. For minimax MSE:

$$\delta^* = \argmin_\delta \left[\frac{1}{2}(\omega(\delta) - \delta\omega'(\delta))\right]^2 + \sigma^2[\omega'(\delta)]^2$$

For a given tuning parameter $\sigma$ in the balancing weights, $\delta$ is determined by the first-order condition of this optimization.

## Key observations

1. The $L_2$ norm in the constraint is on **treated units only** ($P_n^{W=1}$), not all units — consistent with our earlier finding
2. The functional sums over **all units** — consistent with earlier
3. $\delta$ has a direct interpretation: how far two functions in the model can be while having different means, measured in units of the treated-sample $L_2$ norm divided by $\sigma$
4. The factor of $1/2$ distinguishes this from the penalized form (which has no $1/2$)

## For the paper

The equation should display:
$$\text{imbalance}_\mathcal{M}(\hat\gamma) \le \frac{1}{2}\left(\omega(\delta) - \delta\omega'(\delta)\right) \quad\text{where}\quad \omega(\delta) = \sup\left\{\left|\frac{1}{n}\sum_i m_1(X_i) - \frac{1}{n}\sum_i m_2(X_i)\right| : m_1, m_2 \in \mathcal{M},\; \|m_1-m_2\|_{L_2(P_n)} \le \delta\right\}$$

Note: I used $L_2(P_n)$ (all units) here instead of $L_2(P_n^{W=1})$ (treated only). Need to decide which — the Armstrong framework uses treated only (through $K$), but Skip earlier said use full $L_2(P_n)$ since the optimizer zeros out on controls. This needs Skip's input.
