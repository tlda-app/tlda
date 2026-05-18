## Bias bound components v3: proper s-dependence for offset complexity
## For any s: bias ≤ 2[Ξ(s) + μ_ρ(1 - s·ρ(φ̃))]
## Ξ(s) = r*(s)²/(2s) where r*(s) is the critical radius at scale s

library(ggplot2)
library(svglite)

set.seed(42)

## ---- Setup: wiggly propensity, Matern-3/2 ----
n <- 200
d <- 1
X <- matrix(sort(runif(n)), n, d)
lp <- 4 * sin(6 * X[,1]) + 2 * X[,1]
e_x <- plogis(lp)
e_x <- pmax(e_x, 0.05); e_x <- pmin(e_x, 0.95)
W <- rbinom(n, 1, e_x)
gamma_ipw <- 1 / e_x
idx1 <- which(W == 1)
N1 <- length(idx1)
message(sprintf("n=%d, N1=%d", n, N1))

## Matern-3/2 kernel
matern_kernel <- function(X, nu, ell) {
  D <- as.matrix(dist(X))
  if (nu == 1.5) { r <- sqrt(3) * D / ell; (1 + r) * exp(-r) }
  else if (nu == 2.5) { r <- sqrt(5) * D / ell; (1 + r + r^2/3) * exp(-r) }
}

ell <- 0.15
K <- matern_kernel(X, nu = 1.5, ell = ell)

## Eigendecompose full kernel
eig_full <- eigen(K, symmetric = TRUE)
lambda_full <- pmax(eig_full$values, 0)

## Eigendecompose treated kernel (for ridge)
K_11 <- K[idx1, idx1]
eig_11 <- eigen(K_11, symmetric = TRUE)
lambda_11 <- pmax(eig_11$values, 0)
U_11 <- eig_11$vectors
gamma_eig <- as.numeric(t(U_11) %*% gamma_ipw[idx1])

## ---- Offset complexity: Ξ(s) = r*(s)²/(2s) ----
## Critical radius at scale s: r*(s) solves
##   r²/2 = local_rad(s, r)
## where local_rad(s, r)² ≈ (1/n²) Σ_j min(s² λ_j, r²)
## (Bartlett-Mendelson for the intersection B_ρ(s) ∩ B_2(r))

compute_xi <- function(s, lambda, nn) {
  local_rad <- function(r) {
    ## Rademacher complexity of {h: ||h||_H ≤ s, ||h||_2 ≤ r}
    ## R ≈ sqrt( (1/n) sum min(s^2 lambda_j / n, r^2) )
    sqrt(sum(pmin(s^2 * lambda / nn, r^2)) / nn)
  }

  ## Find r* such that r²/2 = local_rad(r)
  f <- function(r) r^2/2 - local_rad(r)
  if (f(1e-8) >= 0) return(list(r = 1e-8, xi = 1e-16 / (2*s)))
  rmax <- 10
  if (f(rmax) <= 0) return(list(r = rmax, xi = rmax^2 / (2*s)))
  r_star <- tryCatch(uniroot(f, c(1e-8, rmax))$root, error = function(e) NA)
  if (is.na(r_star)) return(list(r = NA, xi = NA))
  list(r = r_star, xi = r_star^2 / (2 * s))
}

## ---- Subgradient term for given sigma ----
## φ̃ = population ridge: alpha_eig = gamma_eig / (lambda_11 + sigma²)
## ||φ̃||_H² = sum alpha_eig² * lambda_11
## μ_ρ = sigma² * ||φ̃||_H / N1

compute_subgrad <- function(sigma, s, lambda_11, gamma_eig, N1) {
  alpha_eig <- gamma_eig / (lambda_11 + sigma^2)
  phi_norm <- sqrt(sum(alpha_eig^2 * lambda_11))
  mu_rho <- sigma^2 * phi_norm / N1
  sg <- mu_rho * pmax(1 - s * phi_norm, 0)
  list(phi_norm = phi_norm, mu_rho = mu_rho, subgrad = sg)
}

## ---- Compute for grid of s, multiple sigma ----
s_grid <- exp(seq(log(0.01), log(5), length.out = 300))
sigma_vals <- c(0.3, 1.0, 3.0)

all_results <- list()
for (sigma in sigma_vals) {
  xi_vals <- numeric(length(s_grid))
  sg_vals <- numeric(length(s_grid))
  r_vals <- numeric(length(s_grid))

  sg_info <- compute_subgrad(sigma, 0, lambda_11, gamma_eig, N1)
  phi_norm <- sg_info$phi_norm
  mu_rho <- sg_info$mu_rho
  message(sprintf("sigma=%.1f: phi_norm=%.2f, mu_rho=%.4f", sigma, phi_norm, mu_rho))

  for (i in seq_along(s_grid)) {
    s <- s_grid[i]
    xi_res <- compute_xi(s, lambda_full, n)
    xi_vals[i] <- xi_res$xi
    r_vals[i] <- xi_res$r
    sg_vals[i] <- mu_rho * pmax(1 - s * phi_norm, 0)
  }

  all_results[[as.character(sigma)]] <- data.frame(
    s = s_grid,
    xi = xi_vals,
    subgrad = sg_vals,
    total = 2 * (xi_vals + sg_vals),
    sigma = sigma,
    sigma_label = sprintf("σ = %.1f", sigma)
  )
}

df <- do.call(rbind, all_results)
ref <- 1 / sqrt(n)

## ---- Plot ----
df_long <- rbind(
  data.frame(s = df$s, value = df$xi, component = "Offset complexity Ξ(s)",
             sigma_label = df$sigma_label),
  data.frame(s = df$s, value = df$subgrad, component = "Subgradient term",
             sigma_label = df$sigma_label)
)
## Drop zeros for log scale
df_long <- df_long[df_long$value > 1e-10, ]

p <- ggplot(df_long, aes(x = s, y = value, color = component, linetype = component)) +
  geom_line(linewidth = 0.8) +
  geom_hline(yintercept = ref, color = "gray50", linetype = "dotted", linewidth = 0.5) +
  facet_wrap(~sigma_label, nrow = 1) +
  scale_x_log10() +
  scale_y_log10(limits = c(1e-4, 1)) +
  scale_color_manual(values = c("Offset complexity Ξ(s)" = "steelblue",
                                "Subgradient term" = "firebrick")) +
  scale_linetype_manual(values = c("Offset complexity Ξ(s)" = "solid",
                                   "Subgradient term" = "dashed")) +
  labs(x = "s (modulus parameter)",
       y = "Contribution to bias bound",
       color = NULL, linetype = NULL) +
  theme_minimal(base_size = 11) +
  theme(legend.position = "bottom", panel.grid.minor = element_blank(),
        strip.text = element_text(size = 11))

outfile <- "scratch/bias-bound-v3.svg"
ggsave(outfile, p, width = 10, height = 4.5)
message(sprintf("Saved to %s", outfile))

## Print summary
for (sigma in sigma_vals) {
  sub <- df[df$sigma == sigma, ]
  best_s <- sub$s[which.min(sub$total)]
  best_total <- min(sub$total)
  best_xi <- sub$xi[which.min(sub$total)]
  best_sg <- sub$subgrad[which.min(sub$total)]
  message(sprintf("sigma=%.1f: best s=%.3f, total=%.4f (xi=%.4f, sg=%.4f), n^{-1/2}=%.4f",
                  sigma, best_s, best_total, best_xi, best_sg, ref))
}
