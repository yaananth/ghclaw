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

# 6. Create launcher script
# Resolve bun's absolute path so the launcher works even if ~/.bun/bin isn't in PATH
BUN_PATH="$(command -v bun)"
LAUNCHER_CONTENT="#!/usr/bin/env bash
GHCLAW_DIR=\"\${GHCLAW_INSTALL_DIR:-\$HOME/.ghclaw-src}\"
BUN=\"\$(command -v bun 2>/dev/null || echo \"$BUN_PATH\")\"
exec \"\$BUN\" run \"\$GHCLAW_DIR/bin/ghclaw.ts\" \"\$@\""

BIN_DIR=""
# Try /usr/local/bin first (always in PATH, writable in containers/Codespaces)
if [ -w "/usr/local/bin" ]; then
  BIN_DIR="/usr/local/bin"
# Try ~/.local/bin if it's already in PATH
elif echo "$PATH" | grep -q "$HOME/.local/bin"; then
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
# Try ~/.bun/bin (bun installer adds this to shell rc)
elif [ -d "${BUN_INSTALL:-$HOME/.bun}/bin" ]; then
  BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
else
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
fi

echo "$LAUNCHER_CONTENT" > "$BIN_DIR/ghclaw"
chmod +x "$BIN_DIR/ghclaw"

# Also place in ~/.local/bin and ~/.bun/bin as fallbacks
for EXTRA_DIR in "$HOME/.local/bin" "${BUN_INSTALL:-$HOME/.bun}/bin"; do
  if [ -d "$EXTRA_DIR" ] && [ "$EXTRA_DIR" != "$BIN_DIR" ]; then
    echo "$LAUNCHER_CONTENT" > "$EXTRA_DIR/ghclaw" 2>/dev/null || true
    chmod +x "$EXTRA_DIR/ghclaw" 2>/dev/null || true
  fi
done

# 7. Verify
export PATH="$BIN_DIR:$HOME/.local/bin:${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
echo ""
if command -v ghclaw &>/dev/null; then
  echo "  ✅ ghclaw installed! ($(which ghclaw))"
  echo ""
  echo "  Next: ghclaw setup"
else
  echo "  ✅ ghclaw installed to $BIN_DIR"
  echo ""
  echo "  If 'ghclaw' is not found, open a new terminal or run:"
  echo "    source ~/.bashrc"
  echo ""
  echo "  Then: ghclaw setup"
fi
echo ""
