#' # Modulus of continuity — tangent line illustration
#'
#' Shows omega(s) as a concave function, the tangent line at the optimal s,
#' and the intercept omega(s) - omega'(s)*s which equals the maximal imbalance.
#' Two panels: (A) nonlinear omega where the intercept is positive,
#'             (B) approximately linear omega where the intercept is near zero.

library(ggplot2)
library(patchwork)

# --- Modulus functions ---

# Panel A: omega(s) = s^alpha for alpha < 1 (concave, nonlinear)
# The intercept is omega(s) - omega'(s)*s = s^alpha - alpha*s^(alpha-1)*s = (1-alpha)*s^alpha
alpha_A <- 0.6
omega_A <- function(s) s^alpha_A
domega_A <- function(s) alpha_A * s^(alpha_A - 1)

# Panel B: omega(s) = c*s + epsilon * s^alpha (nearly linear)
c_B <- 1.0
eps_B <- 0.05
alpha_B <- 0.5
omega_B <- function(s) c_B * s + eps_B * s^alpha_B
domega_B <- function(s) c_B + eps_B * alpha_B * s^(alpha_B - 1)

# --- Tangent line and intercept ---
tangent_line <- function(s0, omega_fn, domega_fn) {
  y0 <- omega_fn(s0)
  m <- domega_fn(s0)
  intercept <- y0 - m * s0
  list(slope = m, intercept = intercept, s0 = s0, y0 = y0)
}

# Choose tangent points
s0_A <- 1.5
s0_B <- 1.5

tA <- tangent_line(s0_A, omega_A, domega_A)
tB <- tangent_line(s0_B, omega_B, domega_B)

# --- Build plot data ---
s_grid <- seq(0.01, 3, length.out = 300)

df_A <- data.frame(s = s_grid, omega = omega_A(s_grid))
df_B <- data.frame(s = s_grid, omega = omega_B(s_grid))

# Tangent lines
tang_A <- data.frame(s = s_grid, y = tA$intercept + tA$slope * s_grid)
tang_B <- data.frame(s = s_grid, y = tB$intercept + tB$slope * s_grid)

# --- Panel A ---
pA <- ggplot() +
  geom_line(data = df_A, aes(x = s, y = omega), linewidth = 0.8) +
  geom_line(data = tang_A, aes(x = s, y = y), linetype = "dashed", color = "gray40", linewidth = 0.5) +
  geom_point(aes(x = s0_A, y = tA$y0), size = 2) +
  # Mark intercept
  geom_segment(aes(x = 0, xend = 0, y = 0, yend = tA$intercept),
               color = "red3", linewidth = 1) +
  geom_point(aes(x = 0, y = tA$intercept), color = "red3", size = 2.5) +
  annotate("text", x = 0.15, y = tA$intercept, label = "bias",
           color = "red3", hjust = 0, vjust = 0.5, size = 3.5) +
  coord_cartesian(xlim = c(-0.1, 3), ylim = c(-0.1, max(df_A$omega) * 1.05)) +
  labs(x = expression(italic(s)), y = expression(omega(italic(s))),
       title = "Nonlinear modulus") +
  theme_minimal(base_size = 11) +
  theme(plot.background = element_rect(fill = "white", colour = NA),
        panel.grid.minor = element_blank())

# --- Panel B ---
pB <- ggplot() +
  geom_line(data = df_B, aes(x = s, y = omega), linewidth = 0.8) +
  geom_line(data = tang_B, aes(x = s, y = y), linetype = "dashed", color = "gray40", linewidth = 0.5) +
  geom_point(aes(x = s0_B, y = tB$y0), size = 2) +
  # Mark intercept (near zero)
  geom_segment(aes(x = 0, xend = 0, y = 0, yend = tB$intercept),
               color = "red3", linewidth = 1) +
  geom_point(aes(x = 0, y = tB$intercept), color = "red3", size = 2.5) +
  annotate("text", x = 0.15, y = tB$intercept + 0.05, label = expression(bias %~~% 0),
           color = "red3", hjust = 0, vjust = 0.5, size = 3.5) +
  coord_cartesian(xlim = c(-0.1, 3), ylim = c(-0.1, max(df_B$omega) * 1.05)) +
  labs(x = expression(italic(s)), y = expression(omega(italic(s))),
       title = "Nearly linear modulus") +
  theme_minimal(base_size = 11) +
  theme(plot.background = element_rect(fill = "white", colour = NA),
        panel.grid.minor = element_blank())

# --- Combine ---
p <- pA + pB +
  plot_annotation(
    caption = expression(paste("Bias = ", omega(s) - omega*"'"*(s) %.% s,
                               " = y-intercept of tangent line"))
  )

ggsave("figure/modulus-tangent-line.pdf", p, width = 7, height = 3.2)
message("Saved figure/modulus-tangent-line.pdf")
