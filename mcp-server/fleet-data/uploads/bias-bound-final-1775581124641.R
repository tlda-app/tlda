## Final bias bound figure — companion to the modulus tangent-line figure
##
## Shows:
## - Actual bound (at phi_tilde centering): blue, decreasing
## - Competitor bound (optimized over B): red dashed, increasing
## - n^{-1/2} reference
## - They converge where optimal competitor = phi_tilde
##
## Uses: wiggly propensity, Matern-3/2, n=500, sigma=3
## Style: match modulus-plot.R (theme_minimal, white bg, clean)

library(ggplot2)
library(svglite)

set.seed(42)

n <- 500; d <- 1
X <- matrix(sort(runif(n)), n, d)
lp <- 4 * sin(6 * X[,1]) + 2 * X[,1]
e_x <- plogis(lp); e_x <- pmax(e_x, 0.08); e_x <- pmin(e_x, 0.92)
W <- rbinom(n, 1, e_x)
gamma_ipw <- 1/e_x
idx1 <- which(W == 1); N1 <- length(idx1)
message(sprintf("n=%d, N1=%d, gamma=[%.1f, %.1f]", n, N1, min(gamma_ipw), max(gamma_ipw)))

K <- (function(X, ell) {
  D <- as.matrix(dist(X)); r <- sqrt(3)*D/ell; (1+r)*exp(-r)
})(X, 0.25)

eig <- eigen(K, symmetric = TRUE)
keep <- which(eig$values > max(eig$values) * 1e-6)
if (length(keep) > 200) keep <- keep[1:200]
lam <- eig$values[keep]; U <- eig$vectors[, keep]
p_dim <- length(lam)

K_11 <- K[idx1, idx1]
eig_11 <- eigen(K_11, symmetric = TRUE)
keep_11 <- which(eig_11$values > max(eig_11$values) * 1e-6)
if (length(keep_11) > 200) keep_11 <- keep_11[1:200]
lam_11 <- eig_11$values[keep_11]; U_11 <- eig_11$vectors[, keep_11]
gamma_eig <- as.numeric(t(U_11) %*% gamma_ipw[idx1])

sigma <- 3; eta <- sigma^2 / (2 * n)

UL <- sweep(U, 2, lam, "*")
UL_treat <- UL[idx1, , drop = FALSE]
Q <- crossprod(UL_treat) / N1

compute_omega <- function(cc_vec, s_val, ridge = 1e-8) {
  tryCatch({
    cfn <- function(nu) {
      A <- Q/s_val + 2*nu*diag(lam) + ridge*diag(p_dim)
      beta <- solve(A, cc_vec); sum(lam*beta^2)-1
    }
    if (cfn(0) <= 0) nu <- 0
    else {
      hi <- 1; while(cfn(hi)>0 && hi<1e15) hi <- hi*10
      lo <- 0; for(j in 1:80){mid<-(lo+hi)/2; if(cfn(mid)>0) lo<-mid else hi<-mid}
      nu <- (lo+hi)/2
    }
    A <- Q/s_val + 2*nu*diag(lam) + ridge*diag(p_dim)
    beta <- solve(A, cc_vec)
    sum(cc_vec*beta) - as.numeric(t(beta)%*%Q%*%beta)/(2*s_val)
  }, error = function(e) NA)
}

find_ridge <- function(B_target) {
  norm_at <- function(lr) {
    ae <- gamma_eig/(lam_11+lr); sqrt(sum(ae^2*lam_11))
  }
  nmax <- norm_at(1e-6)
  if (B_target >= nmax) return(1e-6)
  lo <- 1e-6; hi <- 1e8
  for(i in 1:100){mid<-sqrt(lo*hi); if(norm_at(mid)>B_target) lo<-mid else hi<-mid}
  sqrt(lo*hi)
}

compute_g_vals <- function(lambda_reg) {
  ae <- gamma_eig/(lam_11+lambda_reg)
  alpha_treated <- U_11 %*% ae
  as.numeric(K[,idx1] %*% alpha_treated)
}

## phi_tilde
alpha_eig_phi <- gamma_eig/(lam_11+sigma^2)
phi_all <- as.numeric(K[,idx1] %*% (U_11 %*% alpha_eig_phi))
phi_norm <- sqrt(sum(alpha_eig_phi^2 * lam_11))
mu_rho <- eta * phi_norm
s_max <- 1/(2*phi_norm)
message(sprintf("phi_norm=%.3f, mu_rho=%.4f, s_max=%.3f", phi_norm, mu_rho, s_max))

cc_phi <- as.numeric(t(UL) %*% (1 - W*phi_all)) / n

s_grid <- exp(seq(log(0.003), log(s_max*0.99), length.out = 120))
ref <- 1/sqrt(n)

## 1. Actual bound
message("Actual bound...")
xi_phi <- sapply(s_grid, function(s) compute_omega(cc_phi, s))
xi_phi[is.na(xi_phi)] <- 0
approx_phi <- mu_rho * (1 - s_grid * phi_norm)
actual <- xi_phi + approx_phi

## 2. Competitor bound
message("Competitor bound...")
B_cands <- exp(seq(log(0.05), log(20), length.out = 80))
comp <- numeric(length(s_grid))
for (i in seq_along(s_grid)) {
  s <- s_grid[i]; best <- Inf
  for (B in B_cands) {
    if (s*B >= 0.5) next
    lr <- find_ridge(B); gv <- compute_g_vals(lr)
    ccg <- as.numeric(t(UL) %*% (1-W*gv)) / n
    xig <- compute_omega(ccg, s)
    if (is.na(xig)) next
    tot <- xig + eta*B*(1-s*B)
    if (tot < best) best <- tot
  }
  comp[i] <- best
}
comp[is.infinite(comp)] <- NA

message(sprintf("Actual range: [%.4f, %.4f]", min(actual), max(actual)))
message(sprintf("Competitor range: [%.4f, %.4f]", min(comp,na.rm=T), max(comp,na.rm=T)))
message(sprintf("n^{-1/2} = %.4f", ref))

## ---- Plot: just competitor bound + n^{-1/2} ----
df <- data.frame(s=s_grid, bound=comp)
df <- df[!is.na(df$bound) & df$bound > 0, ]

p <- ggplot(df, aes(x=s, y=bound)) +
  geom_line(linewidth=0.7, color="gray20") +
  geom_hline(yintercept=ref, color="gray50", linetype="dotted", linewidth=0.5) +
  annotate("text", x=s_max*0.9, y=ref*1.08,
           label=expression(n^{-1/2}), color="gray50", size=3.2, hjust=1) +
  coord_cartesian(ylim=c(0, max(df$bound, ref)*1.15)) +
  labs(x=expression(italic(s)), y=NULL) +
  theme_minimal(base_size=10) +
  theme(plot.background=element_rect(fill="white", colour=NA),
        panel.grid.minor=element_blank())

w <- 5; h <- 3.3
ggsave("scratch/bias-bound-final.pdf", p, width=w, height=h)
ggsave("scratch/bias-bound-final.svg", p, width=w, height=h, device=svglite)
ggsave("scratch/bias-bound-final.png", p, width=w, height=h, dpi=300)
message("Saved all formats")
