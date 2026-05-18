# Full Paper Review: The Balancing Act in Causal Inference

## 1. TODOs, Commented-Out Blocks, and Dead Code

These should be cleaned up before submission. In order of visibility:

**Active TODOs (uncommented):**
- **Line 1**: `% TODO: use \bar\psi for sample-average estimand (matching retargeted-mean paper)` -- top of file, will be the first thing a reviewer's eye hits if they look at source
- **Line 772**: `%\footnote{TODO: Say something about how we get normality even with poor overlap...}` -- commented-out TODO footnote
- **Line 1685**: `%\footnotetext{ . } %TODO: replace with the following or an updated version`
- **Line 1697**: `\dah{TODO: Check with Yinchu or Jelena that this characterization is cool.}` -- inside a commented block but this is an author action item

**Commented-out author conversations (Skipitty / \avi / \dah / \eli):**
- Lines 468--469: `%Skipitty: COMMENT ON INSUFFICIENCY...`
- Lines 509--515: Avi/Skip exchange about redundancy
- Lines 542, 547: Avi comment about hard-to-follow phrase; Skip response
- Lines 613--615: Skip/Avi exchange about moment conditions
- Lines 654, 657: `%Skipitty:` notes
- Lines 773--774: Avi/Skip exchange about hard-to-parse paragraph
- Lines 815, 818--819: `%Skipitty:` notes about variance comparison
- Lines 830--833: Avi/Skip exchange about header paragraph
- Lines 927, 944, 970--971: Various author exchanges
- Lines 996, 1016, 1024, 1028--1029, 1046--1047: Avi/Skip/Eli exchanges
- Lines 1303, 1445, 1486: Avi comments

**Commented-out text blocks:**
- Lines 325--330, 375--386: Old introduction paragraphs
- Lines 508--515: Old summary paragraph
- Lines 631--632, 684--725: Several old versions of the dual characterization discussion
- Lines 927--933: Old sentence about post-stratification
- Lines 1041--1047: Commented-out imbalance equation for Sobolev ball
- Lines 1271--1312: Multiple old versions of the augmentation analysis
- Lines 1633--1697: Many old versions of matching variance analysis
- Line 555: `%\textcolor{red}{What about TMLE more generally?...} Let's do this one.` -- editorial note inside the TMLE remark

---

## 2. Notation Consistency

### `\delta m` vs `\dm` vs `\delta \mu_1`

This is the most confusing notation issue in the paper. Three different notations are used for essentially the same object:

- **Line 534**: Introduces $\delta \mu_1 = \mu_1 - \hat\mu_1$ in prose
- **Line 537**: Uses `\dm` in the equation (which expands to $\delta\mu$)
- **Line 539**: Refers to "the regression error function $\delta m$" (dropping the subscript 1)
- **Line 540**: Switches to "$\delta m = \mu_1$"
- **Line 544**: "regression error $\dm$" (back to the macro)

The generic `\dm` ($\delta\mu$) and the specific `\delta\mu_1` are used interchangeably throughout. In the generalized Section 5, `\delta m = \hat\mu - m` (line 1467) where $m$ is the true conditional mean -- but in the earlier sections $\delta\mu_1$ was $\mu_1 - \hat\mu_1$ (note the sign flip: $\mu_1 - \hat\mu_1$ vs $\hat\mu - m$). Check whether the sign convention is consistent.

### `\var` vs `\Var`

**This is actually backwards in the macro definitions.** Line 175: `\DeclareMathOperator{\Var}{var}` (produces lowercase "var"), line 205: `\DeclareMathOperator{\var}{Var}` (produces uppercase "Var"). The two commands produce the opposite of what their names suggest. This means:

- `\Var[Y \mid X]` on line 795 renders as "var" -- correct for Biometrika
- `\var[Y_i \mid X_i, W_i]` on line 1106 renders as "Var" -- **wrong** for Biometrika

The confusing naming also makes it hard to maintain consistency. One of these should be removed or renamed.

### $v_1(x)$ introduced without formal definition

Line 795 introduces $v_1(x) = \text{Var}[Y_i \mid W_i=1, X_i]$ informally in prose. It reappears in Proposition~3 (line 1593ff) as $v_0(x) = \text{Var}[Y \mid W=0, X=x]$. The $v_w$ notation is never given a formal definition; it just appears.

### $\varepsilon_i$ used for two different things

- Lines 484, 537, etc.: $\varepsilon_i = Y_i - \mu_{W_i}(X_i)$ is the regression noise
- Line 1143: $\varepsilon_1, \ldots, \varepsilon_n$ are "independent and identically distributed standard normals, independent of the data" -- Rademacher/Gaussian multipliers

These are completely different objects. The symmetrized imbalance section (around line 1143--1155) uses $\varepsilon$ for the multipliers, then line 1168 switches back to $\varepsilon_i = Y_i - \mu(X_i)$ for regression errors. This collision within the same section is confusing.

### $X_i \in \R^d$ vs $\R^p$

Line 400: "$X_i \in \R^d$ are observed covariates." But from Section 4 onward, the covariate dimension is consistently called $p$ (lines 854, 908, 1000, etc., all reference $p$ covariates). The dimension $d$ from the setup section is never used again.

### $\theta$ vs $\gamma$ for weights in the matching section

Section 6 introduces $\theta_i = \gamma_i / \bar{W}$ as rescaled weights (line 1512), and the rest of that section uses $\theta$. This is fine but worth a sentence noting the relationship more prominently, since the reader has spent 15 pages with $\gamma$.

---

## 3. Writing Quality Issues

### "Straightforward" appears twice

- **Line 368**: "...necessary and sufficient for straightforward inference..." -- in the introduction
- **Line 1660**: "...matching for balance makes statistical inference straightforward..." -- in the matching section

Both should be replaced.

### "Since" used for causation

- **Line 402**: "Since the tuples are randomly drawn..." -- should be "Because"
- **Line 490**: "Since these two terms both have mean zero..." -- should be "Because"

### `Equation~\ref{}` used where `\eqref{}` would be better

Throughout the paper, `Equation~\ref{eq:foo}` is used where `\eqref{eq:foo}` would be more appropriate. Examples:

- Lines 457--458: "Equation~\ref{eq_mipw-balance}" used as a noun -- this is fine, but the pattern is used inconsistently. Some places use `\eqref` parenthetically (e.g., line 461, 571), others use `Equation~\ref` (lines 489, 540, 586, 749, 882, 942, 1023, 1101, 1124). The paper should be consistent.

More problematic: some `\eqref` references are used as nouns:
- **Line 640**: "The special case \eqref{eq_balancing-weights} has a natural minimax interpretation" -- `\eqref` used as noun/subject
- **Line 668**: "The general case \eqref{eq_balancing-weights-general} has a qualitatively similar dual characterization" -- same

### Missing period after display equations

- **Line 1143**: "...we define the \emph{symmetrized imbalance}." -- ends with a period, then the display equation follows. The period should come after the equation, or the sentence should flow into the display.

### Paragraph break between related equations

- Lines 1031--1039: The two Sobolev norms $\norm{m}_{\text{iso}}$ and $\norm{m}_{\text{dom}}$ are given in what looks like separate aligned environments rather than one, but they are closely related. The `\label` tags suggest they are in one `align` block, which is fine.

---

## 4. Mathematical Issues

### Sign convention for $\delta\mu_1$

Line 534: "the regression error function $\delta\mu_1 = \mu_1 - \hat\mu_1$"
Line 1467: "the regression error $\delta m = \hat\mu - m$"

The first is truth-minus-estimate, the second is estimate-minus-truth. The formulas still work (the absolute value in the imbalance bound absorbs the sign), but the prose descriptions should be consistent.

### Equation~\ref{eq:aipw-variance-true-weights} (line 1349)

This equation decomposes the variance of the AIPW estimator with true weights. But the second term is written as the expectation of the squared imbalance in $\dm$. For this to be a variance decomposition, $\dm$ should be non-random (or cross-fit). The text doesn't note this conditioning.

### Corollary~\ref{cor:rounding} (line 1612)

The root-mean-squared weight is defined as $\Gamma = \sqrt{N_1^{-1} \sum \overset{\neg}{W}_i \hat\theta(X_i)^2}$ (using $\hat\theta$, the unrounded weights), but the condition "each squared weight is negligible compared to their sum $n\Gamma^2$" presumably refers to the rounded weights. This could be stated more precisely.

### Proposition~\ref{proposition:clt-general} (line 1467)

The statement says "the regression error $\delta m = \hat\mu - m$" -- but $m$ here is the true conditional mean, which was called $\mu_w$ or $\mu_1$ in the earlier sections. The switch to bare $m$ without explicitly saying "$m(w,x) = \E[Y \mid W=w, X=x]$" could confuse readers coming from the specific case.

---

## 5. Biometrika Conventions

### `\sqrt{}` usage

The Biometrika convention says to avoid `\sqrt{}` and use `(abc)^{1/2}` instead. The paper uses `\sqrt{}` extensively:

- Line 746: $\sqrt{\hat V}$
- Lines 755, 764, etc.: $\sqrt{n^{-1}\sum...}$
- Lines 1138, 1140, 1154, etc.: $\sqrt{\log(p)/n}$, $\sqrt{2\pi}$, $\sqrt{\log(n)}$

This is pervasive. Whether to enforce it everywhere is a judgment call -- some of these would be quite awkward written as $(\cdot)^{1/2}$ -- but the convention is stated.

### `\Var` renders as "var" -- correct for Biometrika

The `\Var` macro renders lowercase "var" per the Biometrika convention. But `\var` renders uppercase "Var" -- and is used at line 1106. This one instance should use `\Var` instead.

### `\Cov` renders as "cov" -- correct

Line 174: `\DeclareMathOperator{\Cov}{cov}` -- this is correct.

### Bracket nesting

Convention: `[ { ( ) } ]` -- parentheses innermost, then braces, then square brackets.

I did not find systematic violations, though a thorough check of every display equation would be needed. The Sobolev norm equations (1031--1039) use `\abs*{...}^2` inside integrals, which seems fine.

---

## 6. Flow and Transitions

### Section 4 to Section 5

The transition from "Balance measures and models" (Section 4) to "Degree of balance" (Section 5) could be smoother. Section 4 ends with a remark on invariance/equivariance and then "Other considerations" -- both somewhat miscellaneous. Section 5 opens with a question ("Why would we choose a smaller model...?") that provides good motivation, but the reader has to context-switch from the nuts-and-bolts model discussion to a more theoretical analysis of trade-offs.

### Section 5.3 (Inner product perspective) to Section 5.4 (Doing better)

Section 5.3 is dense and introduces a distinct analytic framework (inner product of errors, orthogonality). It ends with a reference to optimal double robustness. Section 5.4 then pivots to a different question (beating the true weights) via modulus of continuity. The connection between these two subsections could be made more explicit -- both are about sharpening the analysis beyond what plug-in comparison gives, but they feel like parallel tracks rather than a unified progression.

### Section 5.4 is long and has a lot packed in

This section covers: (1) AIPW variance advantage over IPW, (2) estimated weights beating true weights, (3) calibration/sieve results, (4) the modulus of continuity, (5) the fixed-point connection, (6) the in-sample vs out-of-sample phenomenon (Figure 2), (7) RKHS rates (Remark), (8) the role of augmentation for convex vs nonconvex models. This is a lot of distinct ideas for one subsection. Consider splitting at the modulus-of-continuity discussion.

### Missing introductory paragraph for Section 4

Several author comments note this (`%\avi{header paragraph here?}`). Section 4 jumps straight into "Balancing binary covariates" without a sentence framing what the section will cover. Given its length, a brief roadmap would help.

---

## 7. Miscellaneous Issues

### Double spaces and formatting

- Line 423: "With  Assumptions" -- double space
- Line 749: "accuracy in estimating  $\tilde\psi_1$" -- double space in footnote
- Line 1569: "rounding scheme \eqref{eq:round} is  $o_p$" -- double space

### Reference to `\Cref` / `\cref`

The writing-style guide recommends using `\Cref` for theorem/lemma/section references. The paper uses `Proposition~\ref{...}`, `Assumption~\ref{...}`, `Section~\ref{...}` throughout instead. This is not wrong, but it's inconsistent with the recommended convention and loses the clickable auto-formatting.

### The TMLE remark (Remark 1, line 549)

The remark ends with a stray editorial comment: "Let's do this one. Title: Connection to TMLE." This appears to be a leftover from drafting.

### Footnote on line 1564

Ends with `}` followed by `.` outside the closing brace: `\citep[Chapter 2.5]{van1996weak}}.` -- this has a doubled closing brace that will cause a LaTeX error or produce a stray `}` in output.

### Missing `~` before `\eqref`

Some `\eqref` references lack the non-breaking space:
- Line 461: "above \eqref{eq_mipw-identity}" -- should be "above~\eqref{...}"
- Line 664: "above \eqref{eq_balancing-weights}" -- same

### `Var` in the matching section

Line 1629 (Remark after Proposition 3): `$\mathrm{Var}(\theta\mid W=0)=0$` -- uses raw `\mathrm{Var}` rather than the `\Var` macro.

---

## 8. Section-by-Section Summary of Issues

| Section | Key Issues |
|---------|-----------|
| Preamble | `\var` and `\Var` produce opposite of what their names suggest; both defined |
| 1 (Intro) | "straightforward" on line 368; large commented-out block |
| 2 (Framework) | $d$ vs $p$ for covariate dimension; "Since" for causation (lines 402, 490) |
| 2.3 (AIPW) | $\delta\mu_1$ sign convention; stray editorial note in TMLE remark |
| 3 (Estimating IPW) | Clean; minor commented-out Skipitty notes |
| 4 (Balance models) | Missing intro paragraph; many author-comment leftovers |
| 5.1 (Plugin) | $\varepsilon_i$ collision (regression noise vs Gaussian multipliers) |
| 5.2 (Augmentation) | Dense but well-written |
| 5.3 (Inner product) | Good; transition to 5.4 could be smoother |
| 5.4 (Doing better) | Very long; packs ~8 distinct ideas into one subsection |
| 6 (Other estimands) | Clean; notation shift from specific $\psi_1$ to general $\psi$ well-handled |
| 7 (Matching) | "straightforward" on line 1660; $\Gamma$ definition could be more precise |
| Appendix A--C | Clean proofs; minor double-space issues |
| Appendix D (Rounding) | Lengthy but solid; notation ($\F$ vs $\model$) shifts without comment |
