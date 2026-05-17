#' # Modulus of continuity — empirical, from actual kernel models
#'
#' Draws a sample, builds RKHS kernel matrices, computes the penalized modulus
#' omega(s) = max_{||m||_H <= 1} (1/n) sum m(Xi) - (1/(2sn)) sum m(Xi)^2
#' via eigendecomposition. Two panels: rough kernel (low bandwidth) vs smooth
#' kernel (high bandwidth). Tangent line shows bias = y-intercept.

library(ggplot2)
library(patchwork)

set.seed(42)

# ---- Sample ----
n <- 200
p <- 3
X <- matrix(runif(n * p), n, p)

# ---- Kernel ----
rbf_kernel <- function(X, ell) {
  D2 <- outer(rowSums(X^2), rowSums(X^2), "+") - 2 * X %*% t(X)
  D2[D2 < 0] <- 0
  exp(-D2 / (2 * ell^2))
}

# ---- Compute empirical modulus ----
# omega(s) = max_{alpha'K alpha <= 1} (1/n) 1'K alpha - (1/(2sn)) alpha'K^2 alpha
#
# With eigen K = U Lambda U', beta = U'alpha, c = U'1:
# omega(s) = max_{sum lambda_j beta_j^2 <= 1}
#            sum (lambda_j c_j / n) beta_j - (lambda_j^2 / (2sn)) beta_j^2
#
# KKT: beta_j = (c_j/n) / (2*nu + lambda_j/(sn))
# Constraint: sum lambda_j * (c_j/n)^2 / (2*nu + lambda_j/(sn))^2 = 1
# Solve for nu by bisection.

compute_modulus <- function(K, s_grid) {
  eig <- eigen(K, symmetric = TRUE)
  lambda <- pmax(eig$values, 0)  # numerical safety
  U <- eig$vectors
  cc <- as.numeric(t(U) %*% rep(1, nrow(K)))
  n <- nrow(K)

  # For each s, solve for nu and compute omega
  omega <- numeric(length(s_grid))
  for (idx in seq_along(s_grid)) {
    s <- s_grid[idx]

    # Function of nu: constraint LHS - 1
    constraint_fn <- function(nu) {
      denom <- 2 * nu + lambda / (s * n)
      # avoid division by zero for zero eigenvalues
      keep <- lambda > 1e-12
      sum(lambda[keep] * (cc[keep] / n)^2 / denom[keep]^2) - 1
    }

    # Check if unconstrained solution is feasible (nu=0)
    if (constraint_fn(0) <= 0) {
      # Unconstrained: nu = 0
      nu_star <- 0
    } else {
      # Bisect for nu > 0
      nu_lo <- 0
      nu_hi <- max(lambda) * max(abs(cc)) / n  # generous upper bound
      while (constraint_fn(nu_hi) > 0) nu_hi <- nu_hi * 10
      for (iter in 1:100) {
        nu_mid <- (nu_lo + nu_hi) / 2
        if (constraint_fn(nu_mid) > 0) nu_lo <- nu_mid else nu_hi <- nu_mid
      }
      nu_star <- (nu_lo + nu_hi) / 2
    }

    keep <- lambda > 1e-12
    denom <- 2 * nu_star + lambda / (s * n)
    beta_star <- ifelse(keep, (cc / n) / denom, 0)
    omega[idx] <- sum(lambda * cc / n * beta_star - lambda^2 / (2 * s * n) * beta_star^2)
  }

  omega
}

# ---- Two kernels ----
ell_rough  <- 0.15   # small bandwidth -> rough model -> nonlinear modulus
ell_smooth <- 0.8    # large bandwidth -> smooth model -> nearly linear modulus

K_rough  <- rbf_kernel(X, ell_rough)
K_smooth <- rbf_kernel(X, ell_smooth)

s_grid <- seq(0.005, 3, length.out = 200)
omega_rough  <- compute_modulus(K_rough,  s_grid)
omega_smooth <- compute_modulus(K_smooth, s_grid)

# ---- Plot helper ----
make_panel <- function(s_grid, omega_vals, s0_idx, label_text) {
  s0 <- s_grid[s0_idx]
  y0 <- omega_vals[s0_idx]

  # Numerical derivative
  ds <- s_grid[2] - s_grid[1]
  slope <- (omega_vals[min(s0_idx+1, length(s_grid))] - omega_vals[max(s0_idx-1, 1)]) / (2*ds)
  intercept <- y0 - slope * s0

  df <- data.frame(s = s_grid, omega = omega_vals)
  tang <- data.frame(s = s_grid, y = intercept + slope * s_grid)
  tang$y[tang$y < -0.1 * max(omega_vals, na.rm=TRUE)] <- NA

  ggplot() +
    geom_line(data = df, aes(x = s, y = omega), linewidth = 0.7) +
    geom_line(data = tang, aes(x = s, y = y),
              linetype = "dashed", color = "gray40", linewidth = 0.45, na.rm = TRUE) +
    geom_point(aes(x = s0, y = y0), size = 1.8) +
    geom_segment(aes(x = 0, xend = 0, y = 0, yend = intercept),
                 color = "red3", linewidth = 0.9) +
    geom_point(aes(x = 0, y = intercept), color = "red3", size = 2) +
    annotate("text", x = max(s_grid) * 0.95, y = max(omega_vals) * 0.12,
             label = label_text, hjust = 1, size = 3.2, color = "gray30") +
    coord_cartesian(xlim = c(-0.15, max(s_grid)),
                    ylim = c(-0.03, max(omega_vals) * 1.05)) +
    labs(x = expression(italic(s)), y = expression(omega(italic(s)))) +
    theme_minimal(base_size = 10) +
    theme(plot.background = element_rect(fill = "white", colour = NA),
          panel.grid.minor = element_blank())
}

# Choose tangent points roughly in the middle
s0_rough  <- which.min(abs(s_grid - 1.2))
s0_smooth <- which.min(abs(s_grid - 1.2))

pA <- make_panel(s_grid, omega_rough,  s0_rough,  "bandwidth = 0.15")
pB <- make_panel(s_grid, omega_smooth, s0_smooth, "bandwidth = 0.8")

p <- pA + pB +
  plot_annotation(
    caption = "Empirical modulus of continuity for Gaussian RKHS models on the same sample (n = 200, p = 3).\nRed segment: bias (y-intercept of tangent line). A smoother model has a more linear modulus and smaller bias.",
    theme = theme(plot.caption = element_text(size = 8, color = "gray30", hjust = 0.5,
                                              lineheight = 1.3))
  )

ggsave("figure/modulus-tangent-line.pdf", p, width = 6.5, height = 3)
message("Saved figure/modulus-tangent-line.pdf")
