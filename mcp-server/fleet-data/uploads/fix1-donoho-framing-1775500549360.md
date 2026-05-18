# Fix 1: Donoho framing

## Current (line 1328)

> The results above establish that balancing weights can beat the true weights, but they do not tell us by how much. These results are part of a long tradition of work on minimax estimation of linear functionals (Ibragimov 1985, Donoho 1991, 1994, Armstrong 2018) that provides the tools to answer this. That literature studies problems like ours: estimating a linear functional $\psi_1 = E[\mu_1(X)]$ when $\mu_1$ is known to lie in a convex function class.

## Proposed

> The results above establish that balancing weights can beat the true weights, but they do not tell us by how much. There is a long tradition of work on minimax estimation of linear functionals (Ibragimov 1985, Donoho 1991, 1994) that studies precisely this kind of problem: estimating a linear functional of an unknown function known to lie in a convex class. Its central object is the *modulus of continuity*,
