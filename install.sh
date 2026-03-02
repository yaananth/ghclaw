#!/usr/bin/env bash
set -euo pipefail

# ghclaw installer
# Usage: curl -fsSL https://raw.githubusercontent.com/yaananth/ghclaw/main/install.sh | bash

REPO="https://github.com/yaananth/ghclaw.git"
INSTALL_DIR="${GHCLAW_INSTALL_DIR:-$HOME/.ghclaw-src}"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║         ghclaw installer             ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# 1. Check for bun, install if missing
if command -v bun &>/dev/null; then
  echo "✅ bun $(bun --version)"
else
  echo "📦 Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    echo "❌ bun install failed. Install manually: https://bun.sh"
    exit 1
  fi
  echo "✅ bun $(bun --version)"
fi

# 2. Check for gh CLI
if command -v gh &>/dev/null; then
  echo "✅ gh $(gh --version | head -1 | awk '{print $NF}')"
else
  echo "⚠️  GitHub CLI (gh) not found — needed for GitHub features"
  echo "   Install: https://cli.github.com"
fi

# 3. Check for copilot CLI
if command -v copilot &>/dev/null; then
  echo "✅ copilot CLI found"
else
  echo "⚠️  Copilot CLI not found — needed for AI features"
  echo "   Install: gh extension install github/gh-copilot"
fi

# 4. Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo ""
  echo "🔄 Updating ghclaw..."
  git -C "$INSTALL_DIR" pull --rebase --autostash --quiet
else
  echo ""
  echo "📥 Cloning ghclaw..."
  git clone --quiet "$REPO" "$INSTALL_DIR"
fi

# 5. Install deps
echo "📦 Installing dependencies..."
(cd "$INSTALL_DIR" && bun install --silent)

# 6. Link binary
echo "🔗 Linking ghclaw command..."
(cd "$INSTALL_DIR" && bun link --silent 2>/dev/null || bun link 2>/dev/null)

# 7. Verify
if command -v ghclaw &>/dev/null; then
  echo ""
  echo "  ✅ ghclaw installed!"
  echo ""
  echo "  Next: ghclaw setup"
  echo ""
else
  # bun link might need PATH update
  echo ""
  echo "  ✅ ghclaw installed to $INSTALL_DIR"
  echo ""
  echo "  Add to PATH if needed:"
  echo "    export PATH=\"\$HOME/.bun/bin:\$PATH\""
  echo ""
  echo "  Then run: ghclaw setup"
  echo ""
fi
