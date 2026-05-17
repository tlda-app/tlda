## Explore: bias bound from offset complexity as a function of B
## Uses cached kernel eigenvalues from modulus-two-panel-cache.rds

library(ggplot2)

cache <- readRDS("scratch/modulus-two-panel-cache.rds")
K_r <- cache$K_r  # Matern-3/2
K_s <- cache$K_s  # Gaussian RBF

n <- nrow(K_r)

## Critical radius for RKHS with integral operator eigenvalues mu_j
## Kernel matrix eigenvalues are lam_j = n * mu_j
## Fixed-point: r^2 = (1/n) * sum min(s^2 * mu_j, r^2)
##            = (1/n^2) * sum min(s^2 * lam_j, n*r^2)
## Let R = n*r^2: R = (1/n) * sum min(s^2 * lam_j, R)
compute_R_fixedpoint <- function(lam, s_val) {
  f <- function(R) {
    (1/length(lam)) * sum(pmin(s_val^2 * lam, R)) - R
  }
  hi <- s_val^2 * max(lam) + 1
  if (f(hi) <= 0) return(hi)
  lo <- 1e-15
  for (i in 1:200) {
    mid <- (lo + hi) / 2
    if (f(mid) > 0) lo <- mid else hi <- mid
  }
  (lo + hi) / 2
}

## Eigendecompose once
eig_r <- pmax(eigen(K_r, symmetric=TRUE, only.values=TRUE)$values, 0)
eig_s <- pmax(eigen(K_s, symmetric=TRUE, only.values=TRUE)$values, 0)

message(sprintf("Top 5 Matern eigenvalues: %s", paste(round(eig_r[1:5],2), collapse=", ")))
message(sprintf("Top 5 Gauss eigenvalues: %s", paste(round(eig_s[1:5],2), collapse=", ")))

## For each B: s = 1/(2B), compute R, then bias = R/(n*s) = r*^2/s
B_grid <- 10^seq(-1, 4, length.out=200)

compute_bias_curve <- function(lam, B_grid) {
  sapply(B_grid, function(B) {
    s <- 1 / (2 * B)
    R <- compute_R_fixedpoint(lam, s)
    r_star_sq <- R / length(lam)  # r*^2 = R/n
    r_star_sq / s  # bias bound = r*^2/s
  })
}

message("Computing bias bounds...")
bb_r <- compute_bias_curve(eig_r, B_grid)
bb_s <- compute_bias_curve(eig_s, B_grid)

message(sprintf("Bias bound range Matern: %.6f - %.6f", min(bb_r), max(bb_r)))
message(sprintf("Bias bound range Gauss:  %.6f - %.6f", min(bb_s), max(bb_s)))
message(sprintf("n^{-1/2} = %.6f", 1/sqrt(n)))

df <- rbind(
  data.frame(B=B_grid, bias=bb_r, model="Matern-3/2"),
  data.frame(B=B_grid, bias=bb_s, model="Gaussian RBF")
)

p <- ggplot(df, aes(x=B, y=bias, color=model)) +
  geom_line(linewidth=0.7) +
  scale_color_manual(values=c("Matern-3/2"="steelblue", "Gaussian RBF"="darkorange")) +
  scale_x_log10() +
  scale_y_log10() +
  geom_hline(yintercept=1/sqrt(n), linetype="dotted", color="gray50") +
  annotate("text", x=1e4, y=1/sqrt(n)*1.3, label="n^{-1/2}", size=3) +
  labs(x="B", y="bias bound (r*²/s)") +
  theme_minimal(base_size=10) +
  theme(plot.background=element_rect(fill="white", colour=NA))

ggsave("/tmp/bias-bound-explore.png", p, width=8, height=5, dpi=150)
message("Saved to /tmp/bias-bound-explore.png")
