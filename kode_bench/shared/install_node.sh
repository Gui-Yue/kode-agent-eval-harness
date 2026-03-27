#!/usr/bin/env sh
set -eu

NODE_VERSION="${KODE_NODE_VERSION:-20.19.0}"
INSTALL_DIR="${KODE_NODE_INSTALL_DIR:-/tmp/kode-node}"
RUNTIME_PATH_FILE="/installed-agent/runtime-path.sh"

write_runtime_path() {
  cat > "$RUNTIME_PATH_FILE" <<EOF
export PATH="$1:\$PATH"
EOF
}

if command -v node >/dev/null 2>&1; then
  NODE_BIN_DIR="$(dirname "$(command -v node)")"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -ge 20 ]; then
    write_runtime_path "$NODE_BIN_DIR"
    exit 0
  fi
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *)
    echo "Unsupported architecture for Node install: $ARCH" >&2
    exit 1
    ;;
esac

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
TARBALL="node-v${NODE_VERSION}-${OS}-${NODE_ARCH}.tar.gz"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"
TMP_FILE="/tmp/${TARBALL}"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP_FILE"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_FILE" "$URL"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$URL" "$TMP_FILE" <<'PY'
import sys
import urllib.request

url = sys.argv[1]
output = sys.argv[2]

with urllib.request.urlopen(url) as response, open(output, "wb") as handle:
    handle.write(response.read())
PY
else
  echo "curl, wget, or python3 is required to install Node.js" >&2
  exit 1
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP_FILE" -C "$INSTALL_DIR" --strip-components=1
write_runtime_path "$INSTALL_DIR/bin"
