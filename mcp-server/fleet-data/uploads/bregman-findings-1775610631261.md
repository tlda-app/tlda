## What I found in the Bregman paper

### Oracle inequality (blb.tex, eq. oracle-inequality, line 1610)

$$\|\hat\phi - g^*\| \leq \underbrace{\|\hat\phi - \tilde\phi\|}_{\text{estimation}} + \underbrace{\|\tilde\phi - g^*\|}_{\text{approximation}}$$

where $\tilde\phi$ is the population minimizer of the penalized loss.

### Estimation error

Controlled by the main theorems. For Sobolev RKHS $\mathcal{H}^s$ with quadratic penalty $\zeta^* = \lambda\rho^2$ (blb.tex line 1653):

$$\|\hat\phi - \tilde\phi\|_{L_2} \lesssim n^{-s/(2s+d)} \lambda^{-d/(2(2s+d))}$$

### Approximation error (source condition, line 1626–1628)

If $g^* = L_K^r g$ for $g \in L_2$, $r \in (0,1]$, then:

$$\|\tilde\phi - g^*\|_{L_2} \leq \lambda^r \|g\|_{L_2}$$

### Total error (line 1663)

$$\|\hat\phi - g^*\| \lesssim \underbrace{n^{-s/(2s+d)} \lambda^{-d/(2(2s+d))}}_{\text{decreases with } \lambda} + \underbrace{\lambda^{(s^*-s)/(2s)}}_{\text{increases with } \lambda}$$

### Bias-variance tradeoff (line 1616–1620)

- Weak regularization (small λ): small bias, large estimation error
- Strong regularization (large λ): small estimation error, large bias
- Optimal λ balances them

### From the AMLE paper (Hirshberg & Wager 2021, Theorem 2)

$$\tilde\gamma = \arg\min_g \left\{ \|\gamma_\psi - g\|_{L_2(Q)}^2 + \frac{\sigma^2}{n}\|g\|_F^2 \right\}$$

$$\|\hat\gamma - \tilde\gamma\|^2 \leq 6\!\left(\frac{nr^4}{\sigma^2} + \|\tilde\gamma\|_F \cdot r^2\right) \vee 8r^2$$

where $r$ is the critical radius from the Rademacher fixed-point condition.

---

### What I don't know

Is $\|\hat\phi - g^*\|$ the same thing as $\delta^*$ in the modulus sense? Or is $\delta^*$ something else? I can see that the oracle inequality decomposes the total error into estimation + approximation, and that the approximation part is what we've been calling $\varepsilon(B)$. But I don't know how to connect $\|\hat\phi - g^*\|$ to the $\delta$ in $\omega(\delta)$.
