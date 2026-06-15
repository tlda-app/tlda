# Homebrew formula for tlda.
#
# Lives in the tap repo: https://github.com/qtm285/homebrew-tlda
# Copy this file to Formula/tlda.rb in that repo.
#
# Install:
#   brew tap qtm285/tlda
#   brew install tlda
#
# To update after a new release:
#   1. Push a new vX.Y.Z tag to github.com/qtm285/tlda
#   2. The release workflow creates the tarball
#   3. Download the tarball, compute sha256:
#      curl -sL https://github.com/qtm285/tlda/releases/download/vX.Y.Z/tlda-vX.Y.Z.tar.gz | shasum -a 256
#   4. Update url + sha256 below
#   5. Commit to homebrew-tlda

class Tlda < Formula
  desc "Paper review and annotation system for LaTeX papers"
  homepage "https://github.com/qtm285/tlda"
  url "https://github.com/qtm285/tlda/releases/download/v0.3.1/tlda-v0.3.1.tar.gz"
  sha256 "821056ad9f578550816960e03c188ccbf75928c379118332d8569fa1f306f928"
  license "MIT"

  depends_on "node"

  # latexmk and dvisvgm are required at runtime for building LaTeX projects.
  # They can be installed via:
  #   brew install --cask mactex-no-gui   (includes both)
  # or individually via texlive.
  # We don't declare them as depends_on because they typically come from TeX Live,
  # not Homebrew. tlda doctor will flag them if missing.

  def install
    # The release tarball includes a pre-built server/public/ (the viewer SPA).
    # Install production Node dependencies.
    system "npm", "ci", "--omit=dev", "--ignore-scripts"
    libexec.install Dir["*"]
    bin.write_exec_script libexec/"cli/tlda.mjs"
  end

  test do
    # tlda with no args prints help and exits 0
    assert_match "Commands:", shell_output("#{bin}/tlda")
  end
end
