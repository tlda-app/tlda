#' # Modulus — ATE functional, vary smoothness
#'
#' ATE functional: psi(m) = (1/n) sum_i [m(1,Xi) - m(0,Xi)]
#' With factored kernel: m(w,x) = sum_{j: Wj=w} alpha_j k(Xi,Xj)
#' So m(1,Xi) = sum_{j in treated} alpha_j k(Xi,Xj)
#'    m(0,Xi) = sum_{j in control} alpha_j k(Xi,Xj)
#'
#' Vary smoothness: Matern-1/2 (nu=0.5, rough) vs Matern-5/2 (nu=2.5, smooth)
#' in d=3.

library(ggplot2)
library(patchwork)
library(svglite)

set.seed(42)

n <- 500
d <- 3
X <- matrix(runif(n * d), n, d)
lp <- 2 * X[,1] + 1.5 * X[,2] - X[,3] - 1.5
W <- rbinom(n, 1, plogis(lp))
idx1 <- which(W == 1); idx0 <- which(W == 0)
N1 <- length(idx1); N0 <- length(idx0)
message(sprintf("d=%d, n=%d, N1=%d, N0=%d", d, n, N1, N0))

matern_kernel <- function(X, nu, ell) {
  D <- as.matrix(dist(X))
  if (nu == 0.5) exp(-D / ell)
  else if (nu == 1.5) { r <- sqrt(3)*D/ell; (1+r)*exp(-r) }
  else if (nu == 2.5) { r <- sqrt(5)*D/ell; (1+r+r^2/3)*exp(-r) }
}

compute_modulus_ate <- function(K_X, W, s_grid) {
  n <- length(W)
  idx1 <- which(W == 1); idx0 <- which(W == 0)

  # Factored kernel K_Z: block diagonal (treated-treated, control-control)
  # K_Z is n x n with K_Z[i,j] = 1(Wi=Wj) * K_X[i,j]
  match_W <- outer(W, W, "==") * 1.0
  K_Z <- match_W * K_X

  eig <- eigen(K_Z, symmetric = TRUE)
  tol <- max(eig$values) * 1e-6
  keep <- eig$values > tol
  lambda <- eig$values[keep]
  U <- eig$vectors[, keep, drop = FALSE]
  p <- length(lambda)
  message(sprintf("  Keeping %d eigenvectors", p))

  # ATE functional: psi(m) = (1/n) sum_i [m(1,Xi) - m(0,Xi)]
  # m(1,Xi) = sum_{j:Wj=1} alpha_j k(Xi,Xj) = (K_X[i, treated] . alpha[treated])
  # m(0,Xi) = sum_{j:Wj=0} alpha_j k(Xi,Xj) = (K_X[i, control] . alpha[control])
  # psi = (1/n) 1' (K_ate alpha) where K_ate[i,j] = 1(Wj=1)k(Xi,Xj) - 1(Wj=0)k(Xi,Xj)
  K_ate <- K_X * matrix(2*W - 1, n, n, byrow = TRUE)  # col j gets +1 if treated, -1 if control
  psi_vec <- as.numeric(t(K_ate) %*% rep(1, n)) / n

  # In eigenbasis of K_Z: beta = U'alpha
  # Functional: psi_vec' alpha = psi_vec' U beta = cc' beta
  cc <- as.numeric(t(U) %*% psi_vec)

  # RKHS norm: alpha' K_Z alpha = beta' Lambda beta... no.
  # ||m||_H^2 = alpha' K_Z alpha. With beta = U'alpha: alpha = U beta,
  # alpha' K_Z alpha = beta' U' K_Z U beta = beta' Lambda beta.
  # So constraint: sum lambda_j beta_j^2 <= 1.

  # Penalty: (1/(2sn)) sum_i m(Wi,Xi)^2 = (1/(2sn)) ||K_Z alpha||^2 = (1/(2sn)) beta' Lambda^2 beta

  omega <- numeric(length(s_grid))
  for (idx in seq_along(s_grid)) {
    s <- s_grid[idx]
    constraint_fn <- function(nu) {
      denom <- lambda^2/(s*n) + 2*nu*lambda
      beta_opt <- cc / denom
      sum(lambda * beta_opt^2) - 1
    }
    if (constraint_fn(0) <= 0) { nu_star <- 0
    } else {
      nu_hi <- 1; tries <- 0
      while (constraint_fn(nu_hi) > 0 && tries < 50) { nu_hi <- nu_hi*10; tries <- tries+1 }
      nu_lo <- 0
      for (iter in 1:100) {
        nu_mid <- (nu_lo+nu_hi)/2
        if (constraint_fn(nu_mid) > 0) nu_lo <- nu_mid else nu_hi <- nu_mid
      }
      nu_star <- (nu_lo+nu_hi)/2
    }
    denom <- lambda^2/(s*n) + 2*nu_star*lambda
    beta_opt <- cc / denom
    omega[idx] <- sum(cc * beta_opt) - sum(lambda^2/(2*s*n) * beta_opt^2)
  }
  omega
}

ell <- 0.4
K_rough  <- matern_kernel(X, nu = 0.5, ell = ell)
K_smooth <- matern_kernel(X, nu = 2.5, ell = ell)

s_grid <- seq(0.01, 3, length.out = 100)
message("Computing modulus (rough, nu=0.5)...")
omega_r <- compute_modulus_ate(K_rough, W, s_grid)
message("Computing modulus (smooth, nu=2.5)...")
omega_s <- compute_modulus_ate(K_smooth, W, s_grid)

# ---- Plot: omega(s) and omega'(s)*s ----
make_panel <- function(s_grid, omega_vals, label_text) {
  ds <- s_grid[2] - s_grid[1]
  omega_prime <- c(diff(omega_vals)/ds, NA)
  linearization <- omega_prime * s_grid
  df <- data.frame(
    s = rep(s_grid, 2), y = c(omega_vals, linearization),
    curve = rep(c("omega", "lin"), each = length(s_grid))
  )
  df <- df[!is.na(df$y),]
  ymax <- max(omega_vals, na.rm = TRUE)
  nn <- length(s_grid) - 1
  ggplot(df, aes(x = s, y = y, linetype = curve)) +
    geom_ribbon(data = data.frame(s=s_grid[1:nn],
                  ymin=pmax(linearization[1:nn],0), ymax=omega_vals[1:nn]),
                aes(x=s, ymin=ymin, ymax=ymax), inherit.aes=FALSE, fill="red3", alpha=0.15) +
    geom_line(linewidth = 0.7) +
    scale_linetype_manual(values = c("omega"="solid", "lin"="dashed"),
                          labels = c(expression(omega(s)), expression(omega*minute(s) %.% s))) +
    annotate("text", x=max(s_grid)*0.95, y=ymax*0.08, label=label_text, hjust=1, size=3.2, color="gray30") +
    coord_cartesian(xlim=c(0, max(s_grid)), ylim=c(0, ymax*1.05)) +
    labs(x=expression(italic(s)), y=NULL) +
    theme_minimal(base_size=10) +
    theme(plot.background=element_rect(fill="white", colour=NA),
          panel.grid.minor=element_blank(),
          legend.position="inside", legend.position.inside=c(0.35, 0.92),
          legend.title=element_blank(), legend.text.align=0,
          legend.key.width=unit(1.2,"cm"),
          legend.background=element_rect(fill="white", colour=NA))
}

pA <- make_panel(s_grid, omega_r, "2 derivatives")
pB <- make_panel(s_grid, omega_s, "4 derivatives")
p <- pA + pB +
  plot_annotation(
    caption = "ATE modulus for Sobolev-type models with 2 and 4 bounded derivatives (n = 500, d = 3).\nShaded: bias. Rougher model has larger bias at each s.",
    theme = theme(plot.caption = element_text(size=8, color="gray30", hjust=0.5, lineheight=1.3))
  )

w <- 7; h <- 3.3
ggsave("figure/modulus-tangent-line.svg", p, width=w, height=h, device=svglite)
ggsave("figure/modulus-tangent-line.pdf", p, width=w, height=h)
ggsave("figure/modulus-tangent-line.png", p, width=w, height=h, dpi=300)
message("Saved all formats")
