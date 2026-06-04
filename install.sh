#!/usr/bin/env bash
# c-agent installer.  Usage:
#   curl -fsSL https://domain.com/install.sh | bash
# Downloads the prebuilt standalone binary for your OS/arch and installs it as
# `cagent`. No Node required. Override the source with env vars:
#   CAGENT_REPO=owner/repo   CAGENT_BASE_URL=https://.../download   CAGENT_VERSION=v1.2.3
set -euo pipefail

REPO="${CAGENT_REPO:-vietrux/c-agent}"
VERSION="${CAGENT_VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  BASE_URL="${CAGENT_BASE_URL:-https://github.com/$REPO/releases/latest/download}"
else
  BASE_URL="${CAGENT_BASE_URL:-https://github.com/$REPO/releases/download/$VERSION}"
fi
BIN_NAME="cagent"

err() { echo "error: $*" >&2; exit 1; }

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux)  os_tag="linux" ;;
  Darwin) os_tag="darwin" ;;
  *) err "unsupported OS '$os'. On Windows install via: npm i -g c-agent" ;;
esac
case "$arch" in
  x86_64|amd64)   arch_tag="x64" ;;
  arm64|aarch64)  arch_tag="arm64" ;;
  *) err "unsupported arch '$arch'" ;;
esac

asset="cagent-${os_tag}-${arch_tag}"
url="$BASE_URL/$asset"

# Choose an install dir: prefer a writable system bin, else ~/.local/bin (no sudo).
if [ -n "${CAGENT_BIN_DIR:-}" ]; then
  dest="$CAGENT_BIN_DIR"
elif [ -w "/usr/local/bin" ]; then
  dest="/usr/local/bin"
else
  dest="$HOME/.local/bin"
fi
mkdir -p "$dest"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
echo "Downloading $asset from $url"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp" || err "download failed (is the release published?)"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url" || err "download failed (is the release published?)"
else
  err "need curl or wget"
fi

# sanity: a real binary, not an HTML 404 page
if head -c 4 "$tmp" | grep -qi "<htm\|<!do"; then
  err "got an HTML page, not a binary — check CAGENT_REPO/CAGENT_VERSION and that asset '$asset' exists"
fi

chmod +x "$tmp"
mv -f "$tmp" "$dest/$BIN_NAME"
trap - EXIT

echo "Installed $BIN_NAME -> $dest/$BIN_NAME"
case ":$PATH:" in
  *":$dest:"*) ;;
  *) echo "NOTE: $dest is not on your PATH. Add to your shell rc:  export PATH=\"$dest:\$PATH\"" ;;
esac
echo "Next: create ~/.c-agent/settings.json with a provider, then run: cagent"
