# Make a student's install.packages() non-fatal when rendering their submission.
#
# A handout is executable .qmd, and students paste `install.packages("ggplot2")`
# above the library() call because that is what every tutorial shows. On this
# image that line does not merely fail — it takes the whole document with it.
# Rprofile.site sets `pkgType = "both"` for renv's benefit, R on Linux has no
# binary type, and a plain install.packages() inherits the option and stops with
#
#   type == "both" can only be used in R builds that have well-defined binary
#   type (e.g. CRAN binary releases)
#
# which halts knitr. The render produces no pages, and the marking view — which
# waits for pages — sits on "Waiting for …" forever. Two of the five real
# week0-homework submissions were unmarkable for five days for exactly this, and
# the three that rendered were simply the three with no install.packages() call.
#
# The masking is deliberate and its blast radius is deliberate too. This binds
# `install.packages` in the global environment, which is where knitr evaluates
# chunks, so it catches the student's unqualified call and nothing else:
# `utils::install.packages(...)` and renv's own machinery resolve through the
# utils namespace and are untouched. Restoring an renv project still installs.
#
# It does not install. The site library is fixed at image build time and a
# rendering student cannot add to it, so a missing package is going to be
# missing whatever this does; the choice is only whether their other twelve
# answers render. It warns, which reaches build.log, and continues.
install.packages <- function(pkgs, ...) {
  pkgs <- as.character(pkgs)
  missing <- pkgs[!vapply(pkgs, requireNamespace, logical(1), quietly = TRUE)]
  if (length(missing)) {
    warning("install.packages() does nothing on the render server; these are not ",
            "installed and the document will fail where it needs them: ",
            paste(missing, collapse = ", "), call. = FALSE)
  }
  invisible(NULL)
}
