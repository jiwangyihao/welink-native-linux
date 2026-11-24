#!/bin/bash
# Build actual ia32 SDK implementations with the isolated dependency sysroot
# and pinned JSON-C. No stub or shared IM/pedestal target.

set -euo pipefail
cd "$(dirname "$0")"
out=${1:-./NativeIntegration/lib}

: "${WELINK_NATIVE_DEPS:?Set WELINK_NATIVE_DEPS to the prepared dependency prefix (see docs/BUILD.md)}"
if (( $# )); then shift; fi
exec make -f NativeBuild/native.mk \
    DEPS_ROOT="$WELINK_NATIVE_DEPS" OUTPUT="$(realpath -m "$out")" \
    ELECTRON_SOURCE="${WELINK_ELECTRON_SOURCE:-}" \
    NATIVE_CC="${WELINK_NATIVE_CC:-${WELINK_ELECTRON_SOURCE:+$WELINK_ELECTRON_SOURCE/third_party/llvm-build/Release+Asserts/bin/}clang}" \
    JSON_PREFIX="${WELINK_JSON_PREFIX:-$PWD/NativeBuild/json-c}" \
    SQLITE_SOURCE="${WELINK_SQLITE_SOURCE:-$PWD/vendor/sqlite3mc-1.4.6}" \
    INTEGRITY_INCLUDE="${WELINK_NATIVE_INTEGRITY_INCLUDE:-}" \
    -j"${JOBS:-2}" "$@"
