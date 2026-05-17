# Signposting additions — drafts

## 1. $\mathcal{M}$ introduction (after "which serves as a *model*" on line 498)

**Current:** "One natural approach is to think of $\mu_1$ as belonging to some set of functions $\mathcal{M}$, e.g., the set of linear functions, which serves as a *model*."

**Add after:** "This is not a model for the propensity score or a parametric likelihood — it is a set of functions that we believe contains the true conditional mean $\mu_1$, and whose geometry determines how well our weights can control bias."

## 2. Section 5 roadmap (after "we will focus on understanding when this happens" on line 1117)

**Current:** "In this section, we will focus on understanding when this happens."

**Replace with:** "In this section, we will focus on understanding when this happens. We begin by comparing estimated weights to the true inverse propensity weights, then show why this comparison alone is not enough for inference. The resolution involves augmentation and the connection between balance and nonparametric regression, which we develop through the same empirical process tools that govern regression error. We then show that estimated weights can do better than the true weights, and close with an alternative perspective that decomposes the bias into an inner product of estimation errors."

## 3. Symmetrization forward pointer (before "The intuition above" on line 1143)

**Add before the paragraph:** (no addition — the paragraph heading "Symmetrization and the connection to regression" already signals the topic. Instead, add one sentence at the end of the preceding discussion, right before `\paragraph{Symmetrization...}`)

Actually, looking at this more carefully, the motivation issue is that the reader doesn't know why they're about to read about regression. The `\paragraph` title says "connection to regression" but not why that connection matters.

**Add as first sentence of the paragraph, after the heading:** "The same measures of model complexity that govern the difficulty of nonparametric regression also govern balance --- a connection we now make precise, because it gives us the tools to analyze when maximal imbalance is negligible."

## 4. Modulus scaffolding (after the bias formula, line 1337)

**Current:** "When $\omega$ is approximately linear --- $\omega(s) \approx c\,s$ for some constant $c$ --- the maximal imbalance is approximately zero."

**Add after this sentence:** "Geometrically, $\omega(s) - \omega'(s)\,s$ is the $y$-intercept of the tangent line to $\omega$ at $s$. When $\omega$ is linear, every tangent line passes through the origin, so the intercept --- and therefore the maximal imbalance --- is zero."

## 5. Section 5.4 opening (replace current first sentence, line 1386)

**Current:** "The preceding subsections analyze bias through maximal imbalance --- a worst-case measure over the model. Here we take a complementary perspective..."

**Replace with:** "The preceding subsections bound the bias by bounding maximal imbalance --- the worst case over the model. Because the AIPW bias decomposes~\eqref{eq:aug_bias_dr} into an inner product of weight and outcome estimation errors (plus a negligible remainder), bounding maximal imbalance is one way to bound this inner product: it takes the worst case over $\delta m$ in the model. Cauchy--Schwarz gives another bound on the same inner product --- equivalently, the worst case when the model is an $L_2$ ball. Here we work with the inner product directly, which lets us exploit structure that these worst-case bounds cannot: the specific alignment between $\delta\gamma$ and $\delta m$, and a symmetry between the roles of weights and outcomes."
