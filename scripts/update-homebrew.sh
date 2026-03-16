#!/bin/bash
# Script to update Homebrew formula after npm publish
# Usage: ./scripts/update-homebrew.sh <version>
# Example: ./scripts/update-homebrew.sh 1.0.18

set -e

VERSION=$1

if [ -z "$VERSION" ]; then
  echo "❌ Error: Version number required"
  echo "Usage: ./scripts/update-homebrew.sh <version>"
  echo "Example: ./scripts/update-homebrew.sh 1.0.18"
  exit 1
fi

HOMEBREW_REPO_PATH="/Users/vladoivankovic/github/Codeep/homebrew-codeep"
FORMULA_FILE="$HOMEBREW_REPO_PATH/Formula/codeep.rb"

echo "🔍 Fetching SHA256 for codeep@${VERSION}..."
SHA256=$(curl -sL "https://registry.npmjs.org/codeep/-/codeep-${VERSION}.tgz" | shasum -a 256 | awk '{print $1}')

if [ -z "$SHA256" ]; then
  echo "❌ Error: Could not fetch SHA256 for version ${VERSION}"
  echo "Make sure the version is published on npm: https://www.npmjs.com/package/codeep"
  exit 1
fi

echo "✓ SHA256: $SHA256"
echo ""
echo "📝 Updating Homebrew formula..."

# Update formula file
cat > "$FORMULA_FILE" << FORMULA_END
class Codeep < Formula
  desc "AI-powered coding assistant built for the terminal"
  homepage "https://codeep.dev"
  url "https://registry.npmjs.org/codeep/-/codeep-${VERSION}.tgz"
  sha256 "${SHA256}"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", "-g", "--prefix=#{prefix}", "--omit=dev", "codeep@${VERSION}"
  end

  test do
    system "#{bin}/codeep", "--version"
  end
end
FORMULA_END

echo "✓ Formula updated"
echo ""
echo "📦 Committing and pushing to GitHub..."

cd "$HOMEBREW_REPO_PATH"
git add Formula/codeep.rb
git commit -m "Update codeep to v${VERSION}"
git push

echo ""
echo "✅ Done! Homebrew formula updated to v${VERSION}"
echo ""
echo "Users can now update with:"
echo "  brew update"
echo "  brew upgrade codeep"

# ── Update Zed extension ──────────────────────────────────────────────────────
ZED_REPO_PATH="/Users/vladoivankovic/github/Codeep/codeep-zed"
ZED_TOML="$ZED_REPO_PATH/extension.toml"

echo "📝 Updating Zed extension to v${VERSION}..."

# Bump version and archive URLs in extension.toml
sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" "$ZED_TOML"
sed -i '' "s|/releases/download/v[^/]*/|/releases/download/v${VERSION}/|g" "$ZED_TOML"

cd "$ZED_REPO_PATH"
git add extension.toml
git commit -m "Update codeep to v${VERSION}"
git tag "v${VERSION}"
git push
git push origin "v${VERSION}"

echo "✅ Done! Zed extension updated to v${VERSION}"
echo "   GitHub Action will build binaries automatically."
