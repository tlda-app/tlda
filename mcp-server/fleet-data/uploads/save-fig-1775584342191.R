# save_fig: save a ggplot in PDF + SVG + PNG with matched dimensions
#
# Agents should always use this instead of ggsave directly.
# - PDF: for LaTeX (cairo_pdf device, transparent background)
# - SVG: for tlda viewer (svglite device, white background)
# - PNG: for agent viewing / screenshots (white background, 150 dpi)
#
# The three formats use identical width/height so bounding boxes match
# and \includegraphics spacing is consistent between PDF and viewer.
#
# Usage:
#   save_fig(p, "errors-combined-error", width = 7, height = 3.5)
#   save_fig(p, "errors-combined-error", width = 7, height = 3.5, path = fig_dir)

save_fig <- function(plot, name, width, height,
                     path = "~/work/survival/survival-paper/figures",
                     dpi = 150) {
  if (!requireNamespace("svglite", quietly = TRUE))
    stop("svglite package required: install.packages('svglite')")

  path <- path.expand(path)
  pdf_file <- file.path(path, paste0(name, ".pdf"))
  svg_file <- file.path(path, paste0(name, ".svg"))
  png_file <- file.path(path, paste0(name, ".png"))

  ggplot2::ggsave(pdf_file, plot, width = width, height = height,
                  bg = "transparent", device = cairo_pdf)
  ggplot2::ggsave(svg_file, plot, width = width, height = height,
                  bg = "transparent", device = svglite::svglite)
  ggplot2::ggsave(png_file, plot, width = width, height = height,
                  dpi = dpi, bg = "transparent")

  cat(sprintf("Saved: %s  |  %s  |  %s\n",
              basename(pdf_file), basename(svg_file), basename(png_file)))
  invisible(list(pdf = pdf_file, svg = svg_file, png = png_file))
}
