#' # Modulus plot — constrained form, delta on x-axis
#'
#' omega(delta) = sup{ |mean(m1) - mean(m2)| : m1,m2 in M, ||m1-m2||_{L2,treated} <= delta }
#' Bias = (1/2)(omega(delta) - delta * omega'(delta))
#' Two models: Matern-3/2 (rough) vs Gaussian RBF (smooth)

library(ggplot2)
library(svglite)

set.seed(42)

n <- 500
X <- runif(n)
lp <- 2 * X - 1
W <- rbinom(n, 1, plogis(lp))
idx1 <- which(W == 1); N1 <- length(idx1)
message(sprintf("n=%d, N1=%d", n, N1))

# ---- Kernels ----
matern32 <- function(x1, x2, ell) {
  D <- outer(x1, x2, function(a,b) abs(a-b))
  r <- sqrt(3)*D/ell; (1+r)*exp(-r)
}
gaussian_rbf <- function(x1, x2, ell) {
  D2 <- outer(x1, x2, function(a,b) (a-b)^2)
  exp(-D2/(2*ell^2))
}

# ---- Compute constrained modulus ----
# omega(delta) = max_{||m1-m2||_{L2,treated} <= delta} |mean(m1) - mean(m2)|
# With m = m1 - m2 in the difference set M-M, this becomes:
# omega(delta) = max_{||m||_{L2,treated} <= delta, m in M-M} |mean(m)|
# For symmetric M (m in M iff -m in M), M-M = 2M, so:
# omega(delta) = 2 * max_{||m||_{L2,treated} <= delta, m in M} (1/n) sum m(Xi)
#
# In RKHS: m = K_all1 alpha where alpha in R^N1, ||m||_H^2 = alpha'K_11 alpha <= 1
# ||m||_{L2,treated}^2 = (1/N1) (K_11 alpha)'(K_11 alpha) = (1/N1) alpha'K_11^2 alpha
# mean(m) = (1/n) 1'K_all1 alpha = psi' alpha
#
# omega(delta) = 2 * max_{alpha'K_11 alpha <= 1, (1/N1) alpha'K_11^2 alpha <= delta^2} psi'alpha

compute_constrained_modulus <- function(K_X, W, delta_grid) {
  n <- length(W); idx1 <- which(W==1); N1 <- length(idx1)
  K_11 <- K_X[idx1, idx1]; K_all1 <- K_X[, idx1]
  psi_vec <- colSums(K_all1) / n

  eig <- eigen(K_11, symmetric=TRUE)
  tol <- max(eig$values)*1e-6
  keep <- eig$values > tol
  lambda <- eig$values[keep]; V <- eig$vectors[,keep,drop=FALSE]
  cc <- as.numeric(t(V) %*% psi_vec)
  p <- length(lambda)

  # In eigenbasis beta = V'alpha:
  # RKHS norm: sum lambda_j beta_j^2 <= 1
  # L2 treated: (1/N1) sum lambda_j^2 beta_j^2 <= delta^2
  # Functional: sum cc_j beta_j -> maximize
  #
  # Two constraints. Use Lagrangian with two multipliers nu1 (RKHS) and nu2 (L2).
  # FOC: cc_j = 2*nu1*lambda_j*beta_j + 2*nu2*(lambda_j^2/N1)*beta_j
  # beta_j = cc_j / (2*nu1*lambda_j + 2*nu2*lambda_j^2/N1)

  omega <- numeric(length(delta_grid))
  for (idx in seq_along(delta_grid)) {
    delta <- delta_grid[idx]

    # Try with just RKHS constraint active (nu2=0)
    solve_rkhs_only <- function(nu1) {
      denom <- 2*nu1*lambda
      beta <- cc / denom
      sum(lambda * beta^2) - 1
    }

    # Check if RKHS-only solution satisfies L2 constraint
    if (solve_rkhs_only(1e-10) <= 0) {
      # Unconstrained is feasible
      beta_opt <- cc / (2*1e-10*lambda)
      if (sum(lambda^2/N1 * beta_opt^2) <= delta^2) {
        omega[idx] <- 2 * sum(cc * beta_opt)
        next
      }
    }

    # Need both constraints. Binary search over nu1, nu2.
    # Simpler: at each delta, the binding constraint is the tighter one.
    # For small delta, L2 is binding. For large delta, RKHS is binding.

    # Try L2 binding only (nu1=0):
    solve_l2_only <- function(nu2) {
      denom <- 2*nu2*lambda^2/N1
      beta <- cc / denom
      sum(lambda^2/N1 * beta^2) - delta^2
    }

    # Just use the L2 constraint (since for the modulus, the L2 constraint
    # is the one that varies with delta, and the RKHS constraint is the model)
    # Actually we need BOTH. Let me use a simpler approach:
    # maximize cc'beta subject to beta'Lambda beta <= 1 AND beta'Lambda^2/N1 beta <= delta^2

    # Use the fact that both are quadratic constraints on beta.
    # The solution has beta_j = cc_j / (2*nu1*lambda_j + 2*nu2*lambda_j^2/N1)
    # Find nu1, nu2 >= 0 such that both constraints are tight (or one is slack with nu=0)

    # Simple approach: parameterize by nu2, find nu1(nu2) from RKHS constraint
    get_omega_at_nu2 <- function(nu2) {
      inner_solve <- function(nu1) {
        denom <- 2*nu1*lambda + 2*nu2*lambda^2/N1
        beta <- cc / pmax(denom, 1e-15)
        sum(lambda * beta^2) - 1
      }
      # Find nu1 that satisfies RKHS constraint
      if (inner_solve(0) <= 0) {
        nu1 <- 0
      } else {
        lo <- 0; hi <- max(abs(cc)/min(lambda)) * 10
        for (i in 1:100) { m <- (lo+hi)/2; if (inner_solve(m)>0) lo<-m else hi<-m }
        nu1 <- (lo+hi)/2
      }
      denom <- 2*nu1*lambda + 2*nu2*lambda^2/N1
      beta <- cc / pmax(denom, 1e-15)
      list(obj = sum(cc * beta), l2sq = sum(lambda^2/N1 * beta^2))
    }

    # Find nu2 such that L2 constraint is satisfied
    res0 <- get_omega_at_nu2(0)
    if (res0$l2sq <= delta^2) {
      omega[idx] <- 2 * res0$obj
    } else {
      lo <- 0; hi <- 1
      while (get_omega_at_nu2(hi)$l2sq > delta^2) hi <- hi * 10
      for (i in 1:100) {
        m <- (lo+hi)/2
        if (get_omega_at_nu2(m)$l2sq > delta^2) lo <- m else hi <- m
      }
      omega[idx] <- 2 * get_omega_at_nu2((lo+hi)/2)$obj
    }
  }
  omega
}

K_matern <- matern32(X, X, ell=0.3)
K_gauss <- gaussian_rbf(X, X, ell=0.15)

delta_grid <- seq(0.001, 0.5, length.out=150)
message("Computing constrained modulus (Matern)...")
omega_m <- compute_constrained_modulus(K_matern, W, delta_grid)
message("Computing constrained modulus (Gaussian)...")
omega_g <- compute_constrained_modulus(K_gauss, W, delta_grid)

# ---- Compute bias = (1/2)(omega - delta*omega') ----
ds <- delta_grid[2] - delta_grid[1]
nn <- length(delta_grid) - 1
dp_m <- diff(omega_m)/ds; dp_g <- diff(omega_g)/ds
bias_m <- 0.5*(omega_m[1:nn] - delta_grid[1:nn]*dp_m)
bias_g <- 0.5*(omega_g[1:nn] - delta_grid[1:nn]*dp_g)

# ---- Plot ----
tex_theme <- theme_minimal(base_size=10) + theme(
  plot.background=element_rect(fill="transparent",colour=NA),
  panel.background=element_rect(fill="transparent",colour=NA),
  panel.grid.minor=element_blank(),
  panel.grid.major=element_line(color="#edf2f5"),
  axis.ticks=element_blank(),
  axis.text=element_text(colour="#aaaaaa"),
  axis.title=element_text(colour="#aaaaaa",size=9))

df <- data.frame(
  delta = rep(delta_grid[1:nn], 4),
  y = c(omega_m[1:nn], delta_grid[1:nn]*dp_m, omega_g[1:nn], delta_grid[1:nn]*dp_g),
  curve = rep(c("omega","lin","omega","lin"), each=nn),
  model = rep(c("Matern-3/2","Matern-3/2","Gaussian","Gaussian"), each=nn)
)

shade_m <- data.frame(delta=delta_grid[1:nn], ymin=pmax(delta_grid[1:nn]*dp_m,0), ymax=omega_m[1:nn])
shade_g <- data.frame(delta=delta_grid[1:nn], ymin=pmax(delta_grid[1:nn]*dp_g,0), ymax=omega_g[1:nn])

xmax <- 0.4
ymax <- max(omega_m[delta_grid<=xmax])*1.08

p <- ggplot() +
  geom_ribbon(data=shade_m[shade_m$delta<=xmax,],aes(x=delta,ymin=ymin,ymax=ymax),fill="#118ab2",alpha=0.12) +
  geom_ribbon(data=shade_g[shade_g$delta<=xmax,],aes(x=delta,ymin=ymin,ymax=ymax),fill="#06d6a0",alpha=0.12) +
  geom_line(data=df[df$model=="Matern-3/2"&df$curve=="omega"&df$delta<=xmax,],aes(x=delta,y=y),color="#118ab2",linewidth=0.8) +
  geom_line(data=df[df$model=="Matern-3/2"&df$curve=="lin"&df$delta<=xmax,],aes(x=delta,y=y),color="#118ab2",linewidth=0.5,linetype="dashed") +
  geom_line(data=df[df$model=="Gaussian"&df$curve=="omega"&df$delta<=xmax,],aes(x=delta,y=y),color="#06d6a0",linewidth=0.8) +
  geom_line(data=df[df$model=="Gaussian"&df$curve=="lin"&df$delta<=xmax,],aes(x=delta,y=y),color="#06d6a0",linewidth=0.5,linetype="dashed") +
  coord_cartesian(xlim=c(0,xmax),ylim=c(0,ymax),clip="off") +
  labs(x=expression(delta),y=expression(omega(delta))) +
  tex_theme + theme(legend.position="none",plot.margin=margin(5,40,5,5))

svglite("scratch/modulus-constrained.svg",width=5,height=4); print(p); dev.off()
message("Saved scratch/modulus-constrained.svg")
