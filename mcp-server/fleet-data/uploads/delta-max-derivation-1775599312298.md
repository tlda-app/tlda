## Working through the bound

We have a competitor $g \in \mathcal{M}$ with $\|g\|_\mathcal{M} \le B$ and $\|g - \gamma^{\text{ipw}}\|_{L_2} \le \varepsilon$.

The bound on the modulus:

$$\omega(\delta) \le C\,r(\delta)^2 + \frac{\sigma^2}{n}\,B$$

requires $\varepsilon \le r(\delta)$.

So the bound is **valid** at $\delta$ iff $r(\delta) \ge \varepsilon$.

Since $r(\delta)$ increases with $\delta$ (larger $\delta$ = bigger local model = larger critical radius), the condition $r(\delta) \ge \varepsilon$ holds for all $\delta \ge \delta_{\min}$ where $r(\delta_{\min}) = \varepsilon$.

Now: $B$ and $\varepsilon$ are linked. For a given model and $\gamma^{\text{ipw}}$, the best $\varepsilon$ achievable with norm $\le B$ is:

$$\varepsilon(B) = \min\{\|g - \gamma^{\text{ipw}}\|_{L_2} : g \in \mathcal{M},\, \|g\|_\mathcal{M} \le B\}$$

As $B \to \infty$, $\varepsilon(B) \to 0$.

So: $\delta_{\min}(B) = r^{-1}(\varepsilon(B))$.

- Larger $B$ → smaller $\varepsilon(B)$ → smaller $r$ needed → smaller $\delta_{\min}$

The bound at $\delta_{\min}(B)$ is:

$$\omega(\delta_{\min}) \le C\,\varepsilon(B)^2 + \frac{\sigma^2}{n}\,B$$

(since $r(\delta_{\min}) = \varepsilon(B)$, so $C\,r^2 = C\,\varepsilon^2$).

---

**So what's $\delta_{\max}$?**

For the bound to be useful (say $\le n^{-1/2}$), we need:

$$C\,r(\delta)^2 + \frac{\sigma^2}{n}\,B \le n^{-1/2}$$

i.e., $C\,r(\delta)^2 \le n^{-1/2} - \frac{\sigma^2}{n}\,B$.

This gives $\delta_{\max}$: the **largest** $\delta$ where the bound is $\le n^{-1/2}$.

Since $r(\delta)$ increases with $\delta$, $\delta_{\max}$ **decreases** with $B$.

**But this can't be what Skip means.** He says $\delta_{\max}$ should increase with $B$.

---

**What am I missing?**
