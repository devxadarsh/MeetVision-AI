#!/usr/bin/env bash
# Builds the FluidAudio-based Core ML helper and installs it where
# electron-builder picks it up (electron/resources/bin).
#
# Builds a universal binary (arm64 + x86_64) so both macOS targets in
# electron-builder.json are served by one artifact. Falls back to the host
# architecture if the second slice is unavailable.
#
# Requires Swift 6.1+ (the manifest uses package traits) and a macOS SDK with
# Core ML. `swift build` works with the Command Line Tools SDK; a full Xcode
# install is recommended for release/notarized builds.
#
# Usage: bash electron/native/parakeet-coreml/build.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
OUT_DIR="${ROOT_DIR}/electron/resources/bin"
BIN_NAME="parakeet-coreml"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[build-coreml-helper] Skipping: Core ML helper is macOS-only." >&2
  exit 0
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "[build-coreml-helper] Skipping: 'swift' was not found on PATH." >&2
  exit 0
fi

cd "${SCRIPT_DIR}"

build_slice() {
  local label="$1"
  shift
  echo "[build-coreml-helper] Building ${BIN_NAME} (${label})..."
  swift build -c release --product "${BIN_NAME}" "$@"
}

BUILD_ARGS=()
if build_slice "universal arm64+x86_64" --arch arm64 --arch x86_64; then
  BUILD_ARGS=(--arch arm64 --arch x86_64)
else
  echo "[build-coreml-helper] Universal build unavailable; building host arch only." >&2
  build_slice "$(uname -m)" 
fi

BUILT_BIN="$(swift build -c release --show-bin-path ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"})/${BIN_NAME}"
if [[ ! -f "${BUILT_BIN}" ]]; then
  echo "[build-coreml-helper] Build succeeded but binary not found at ${BUILT_BIN}" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
cp "${BUILT_BIN}" "${OUT_DIR}/${BIN_NAME}"
chmod +x "${OUT_DIR}/${BIN_NAME}"

# Ad-hoc sign so the binary runs locally; release builds re-sign during packaging.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "${OUT_DIR}/${BIN_NAME}" || \
    echo "[build-coreml-helper] Warning: ad-hoc codesign failed; continuing." >&2
fi

echo "[build-coreml-helper] Installed ${OUT_DIR}/${BIN_NAME}"
lipo -archs "${OUT_DIR}/${BIN_NAME}" 2>/dev/null || true
