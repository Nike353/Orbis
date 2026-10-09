#!/bin/sh
# One-command setup and launch on macOS and Linux. No sudo or shell-profile edits.
set -eu
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo "Orbis currently supports macOS and Linux." >&2; exit 1 ;;
esac
# Reuse tools installed by an earlier preview.
if [ ! -e "$APP_DIR/.orbis" ] && [ -d "$APP_DIR/.litbench" ]; then
  mv "$APP_DIR/.litbench" "$APP_DIR/.orbis"
fi
if command -v uv >/dev/null 2>&1; then
  ORBIS_UV=$(command -v uv)
else
  ORBIS_UV="$APP_DIR/.orbis/uv/uv"
  if [ ! -x "$ORBIS_UV" ]; then
    echo "Setting up uv for Orbis (one time)…"
    mkdir -p "$APP_DIR/.orbis"
    if ! command -v curl >/dev/null 2>&1; then
      echo "Install curl, or install uv from https://docs.astral.sh/uv/, then retry." >&2
      exit 1
    fi
    curl --proto '=https' --tlsv1.2 -fLsS https://astral.sh/uv/install.sh -o "$APP_DIR/.orbis/install-uv.sh"
    UV_UNMANAGED_INSTALL="$APP_DIR/.orbis/uv" sh "$APP_DIR/.orbis/install-uv.sh"
  fi
fi
cd "$APP_DIR"
exec "$ORBIS_UV" run --locked --python 3.12 python -u scripts/start.py "$@"
