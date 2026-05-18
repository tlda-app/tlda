## Bias bound components v2: find a case where subgradient term matters
## The subgradient matters when gamma_ipw has large model norm relative to n/sigma^2

library(ggplot2)
library(svglite)

set.seed(42)

## ---- Setup ----
n <- 200
d <- 1
X <- matrix(sort(runif(n)), n, d)  # sorted for convenience

## Rough propensity score: sharp logistic with interaction
## This creates gamma_ipw with large variation
lp <- 4 * sin(6 * X[,1]) + 2 * X[,1]  # wiggly logit
e_x <- plogis(lp)
e_x <- pmax(e_x, 0.05); e_x <- pmin(e_x, 0.95)  # trim for overlap
W <- rbinom(n, 1, e_x)
gamma_ipw <- 1 / e_x  # large and variable
idx1 <- which(W == 1)
N1 <- length(idx1)
message(sprintf("n=%d, N1=%d, range(gamma_ipw)=[%.1f, %.1f]", n, N1, min(gamma_ipw), max(gamma_ipw)))

## ---- Matern kernel ----
matern_kernel <- function(X, nu, ell) {
  D <- as.matrix(dist(X))
  if (nu == 1.5) { r <- sqrt(3) * D / ell; (1 + r) * exp(-r) }
  else if (nu == 2.5) { r <- sqrt(5) * D / ell; (1 + r + r^2/3) * exp(-r) }
}

## Use a SHORT lengthscale to make the model struggle
ell <- 0.15
K <- matern_kernel(X, nu = 1.5, ell = ell)

## ---- Compute phi_tilde (population ridge solution) for various sigma ----
## Ridge on treated units: phi minimizes
##   (1/N1) sum_{treated} (gamma_ipw(Xi) - phi(Xi))^2 + (sigma^2/N1) ||phi||_H^2
## In kernel form: phi = K_{11} alpha, alpha minimizes
##   (1/N1)||gamma_treated - K_{11} alpha||^2 + (sigma^2/N1) alpha' K_{11} alpha
## Solution: alpha = (K_{11} + sigma^2 I)^{-1} gamma_treated

K_11 <- K[idx1, idx1]
gamma_treated <- gamma_ipw[idx1]

## Eigendecompose K_11
eig <- eigen(K_11, symmetric = TRUE)
lambda <- pmax(eig$values, 0)
U <- eig$vectors

## Project gamma onto eigenbasis
gamma_eig <- as.numeric(t(U) %*% gamma_treated)

## ---- Local Rademacher complexity (for offset complexity) ----
## Using eigenvalues of full kernel
eig_full <- eigen(K, symmetric = TRUE)
lambda_full <- pmax(eig_full$values, 0)

## Critical radius: r^2/2 = sqrt(sum min(lambda_j/n, r^2) / n)
find_r_crit <- function(lambda_full, n) {
  f <- function(r) {
    r^2/2 - sqrt(sum(pmin(lambda_full/n, r^2)) / n)
  }
  if (f(1e-6) > 0) return(1e-6)
  if (f(5) < 0) return(5)
  uniroot(f, c(1e-6, 5))$root
}

r_crit <- find_r_crit(lambda_full, n)
xi_bound <- r_crit^2
message(sprintf("Critical radius r=%.4f, offset complexity Xi ~ r^2=%.6f", r_crit, xi_bound))

## ---- Compute components for a grid of sigma values ----
sigma_grid <- exp(seq(log(0.05), log(5), length.out = 100))

results <- lapply(sigma_grid, function(sigma) {
  ## Ridge coefficients in eigenbasis
  alpha_eig <- gamma_eig / (lambda + sigma^2)

  ## phi on treated units
  phi_treated <- U %*% (lambda * alpha_eig / (lambda + sigma^2))
  ## Actually: phi = K_{11} alpha = U Lambda U' (U alpha_eig) hmm
  ## alpha_eig = U' alpha, so alpha = U alpha_eig
  ## phi = K_{11} alpha = U Lambda U' U alpha_eig = U Lambda alpha_eig
  ## But alpha_eig = gamma_eig / (lambda + sigma^2)
  ## So phi coefficients in eigenbasis: lambda * gamma_eig / (lambda + sigma^2)
  phi_eig <- lambda * gamma_eig / (lambda + sigma^2)

  ## RKHS norm: ||phi||_H^2 = alpha' K alpha = sum alpha_eig_j^2 * lambda_j
  ## alpha_eig = gamma_eig / (lambda + sigma^2)
  alpha_eig <- gamma_eig / (lambda + sigma^2)
  phi_norm_sq <- sum(alpha_eig^2 * lambda)
  phi_norm <- sqrt(phi_norm_sq)

  ## Subgradient term: (sigma^2/N1) * phi_norm
  ## (using N1 instead of n since ridge is on treated units)
  mu_rho <- sigma^2 * phi_norm / N1

  ## L2 error: ||phi - gamma_ipw||^2 on treated units
  ## phi(Xi) = sum_j phi_eig_j * U[i,j] for treated i
  phi_vals <- as.numeric(U %*% phi_eig)
  l2_err <- sqrt(mean((phi_vals - gamma_treated)^2))

  data.frame(sigma = sigma, phi_norm = phi_norm, mu_rho = mu_rho,
             l2_err = l2_err, xi = xi_bound)
})

df <- do.call(rbind, results)

## Reference: n^{-1/2}
ref <- 1 / sqrt(n)

## ---- Plot: two components as function of sigma ----
df_plot <- rbind(
  data.frame(sigma = df$sigma, value = df$xi, component = "Offset complexity (r²)"),
  data.frame(sigma = df$sigma, value = df$mu_rho, component = "Subgradient term"),
  data.frame(sigma = df$sigma, value = df$xi + df$mu_rho, component = "Total bound")
)

p <- ggplot(df_plot, aes(x = sigma, y = value, color = component, linetype = component)) +
  geom_line(linewidth = 0.9) +
  geom_hline(yintercept = ref, color = "gray50", linetype = "dotted") +
  annotate("text", x = max(sigma_grid) * 0.7, y = ref * 1.4,
           label = expression(n^{-1/2}), color = "gray50", size = 4) +
  scale_x_log10() +
  scale_y_log10() +
  scale_color_manual(values = c("Offset complexity (r²)" = "steelblue",
                                "Subgradient term" = "firebrick",
                                "Total bound" = "black")) +
  scale_linetype_manual(values = c("Offset complexity (r²)" = "dashed",
                                   "Subgradient term" = "dashed",
                                   "Total bound" = "solid")) +
  labs(x = expression(sigma), y = "Bound on bias",
       title = sprintf("Bias bound components (n=%d, Matérn-3/2, wiggly propensity)", n),
       color = NULL, linetype = NULL) +
  theme_minimal(base_size = 12) +
  theme(legend.position = "bottom", panel.grid.minor = element_blank())

outfile <- "scratch/bias-bound-v2.svg"
ggsave(outfile, p, width = 7, height = 5)
message(sprintf("Saved to %s", outfile))

## Also print key values
message(sprintf("\nAt sigma=0.1: phi_norm=%.2f, mu_rho=%.6f, xi=%.6f, total=%.6f, n^{-1/2}=%.4f",
                df$phi_norm[which.min(abs(df$sigma-0.1))],
                df$mu_rho[which.min(abs(df$sigma-0.1))],
                df$xi[1], df$xi[1]+df$mu_rho[which.min(abs(df$sigma-0.1))], ref))
message(sprintf("At sigma=1.0: phi_norm=%.2f, mu_rho=%.6f, xi=%.6f, total=%.6f",
                df$phi_norm[which.min(abs(df$sigma-1))],
                df$mu_rho[which.min(abs(df$sigma-1))],
                df$xi[1], df$xi[1]+df$mu_rho[which.min(abs(df$sigma-1))]))
