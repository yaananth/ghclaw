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

# 6. Create launcher script and symlink
# Use a shell wrapper instead of bun link (which is unreliable for global installs)
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/ghclaw" << 'LAUNCHER'
#!/usr/bin/env bash
GHCLAW_DIR="${GHCLAW_INSTALL_DIR:-$HOME/.ghclaw-src}"
exec bun run "$GHCLAW_DIR/bin/ghclaw.ts" "$@"
LAUNCHER
chmod +x "$BIN_DIR/ghclaw"

# Also symlink to ~/.bun/bin in case that's in PATH but ~/.local/bin isn't
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
if [ -d "$BUN_BIN" ] && [ "$BUN_BIN" != "$BIN_DIR" ]; then
  ln -sf "$BIN_DIR/ghclaw" "$BUN_BIN/ghclaw" 2>/dev/null || true
fi

# 7. Verify and guide PATH setup
echo ""
if command -v ghclaw &>/dev/null; then
  echo "  ✅ ghclaw installed!"
  echo ""
  echo "  Next: ghclaw setup"
else
  # Detect which shell config to update
  SHELL_RC=""
  if [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
  elif [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.profile" ]; then
    SHELL_RC="$HOME/.profile"
  fi

  # Auto-add to PATH if not already there
  if [ -n "$SHELL_RC" ] && ! grep -q '\.local/bin' "$SHELL_RC" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
    echo "  Added ~/.local/bin to PATH in $SHELL_RC"
  fi

  echo "  ✅ ghclaw installed!"
  echo ""
  echo "  Run this to start using it now:"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
  echo "  Then: ghclaw setup"
fi
echo ""
