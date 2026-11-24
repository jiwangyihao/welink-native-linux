#!/usr/bin/env bash
# Build genuine ffi-napi 4.0.3 + ref-napi 3.0.3 for Electron 22.3.26 Linux ia32.
# These are an upstream source pair, NOT the private vendor 4.0.12/4.0.8 builds.
# Vendor PointerBuffer/isAddress/int32 extensions are deliberately not aliased.
# Source differences and all archive pins are recorded in ffi/source-lock.json.
#
# This driver follows the upstream binding.gyp and deps/libffi/libffi.gyp Linux
# ia32 source lists directly. It runs no npm install hooks, node-gyp, configure
# probes, foreign prebuilds, native addons or SDKs. The header distribution's
# config.gypi happens to describe arm64; it must NOT drive this ia32 N-API build.
# Only the real Electron C N-API/libuv headers and the pinned ia32 libffi config
# are used. N-API/uv symbols resolve against Electron, not a host libnode/libuv.
# Parent applies its library.js createLibrary override after this assembly.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: build_ffi.sh --build-dir DIR --output DIR --electron-source DIR [--archives DIR]

All build paths are explicit; output must not already exist. --electron-source
accepts the pinned toolchain layout produced by bootstrap.py or a full matching
Electron source tree. No downloads or global package installs are performed.
The installed layout is output/ffi-napi/{lib,build/Release} and
output/node_modules, including ref-napi/build/Release/binding.node.
USAGE
}

die() { printf 'build_ffi: %s\n' "$*" >&2; exit 1; }

BUILD_DIR=
OUTPUT=
ELECTRON_SOURCE=${WELINK_ELECTRON_SOURCE:-}
ARCHIVES=
while (($#)); do
  case "$1" in
    --build-dir|--output|--electron-source|--archives)
      (($# >= 2)) || die "Missing value for $1"
      case "$1" in
        --build-dir) BUILD_DIR=$2 ;;
        --output) OUTPUT=$2 ;;
        --electron-source) ELECTRON_SOURCE=$2 ;;
        --archives) ARCHIVES=$2 ;;
      esac
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ -n "$BUILD_DIR" && -n "$OUTPUT" && -n "$ELECTRON_SOURCE" ]] || { usage >&2; exit 1; }

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
INPUTS=$SCRIPT_DIR/ffi
ARCHIVES=${ARCHIVES:-$INPUTS/archives}
BUILD_DIR=$(realpath -m -- "$BUILD_DIR")
OUTPUT=$(realpath -m -- "$OUTPUT")
ELECTRON_SOURCE=$(realpath -e -- "$ELECTRON_SOURCE")
[[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] || die "Output already exists: $OUTPUT"
case "$OUTPUT/" in "$BUILD_DIR/"*) die "Output must be outside the build directory" ;; esac
case "$BUILD_DIR/" in "$OUTPUT/"*) die "Build directory must be outside the output directory" ;; esac

LLVM=$ELECTRON_SOURCE/third_party/llvm-build/Release+Asserts/bin
SYSROOT=$ELECTRON_SOURCE/build/linux/debian_bullseye_i386-sysroot
GCC_RUNTIME=$SYSROOT/usr/lib/gcc/i686-linux-gnu/10
for executable in "$LLVM/clang" "$LLVM/clang++" "$LLVM/ld.lld"; do
  [[ -x "$executable" ]] || die "Missing executable: $executable"
done
for prerequisite in \
  "$GCC_RUNTIME/crtbeginS.o" "$GCC_RUNTIME/crtendS.o" \
  "$GCC_RUNTIME/libgcc.a" "$GCC_RUNTIME/libstdc++.so" \
  "$SYSROOT/usr/lib/i386-linux-gnu/crti.o" \
  "$SYSROOT/usr/lib/i386-linux-gnu/crtn.o" \
  "$SYSROOT/usr/include/c++/10/vector" \
  "$SYSROOT/usr/include/i386-linux-gnu/c++/10/bits/c++config.h"; do
  [[ -r "$prerequisite" ]] || die "Missing Bullseye ia32 development input: $prerequisite"
done
command -v python3 >/dev/null || die 'Python 3 is required for offline archive assembly'

# Do not let host-global include/library settings leak into the cross build.
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH LIBRARY_PATH
unset COMPILER_PATH GCC_EXEC_PREFIX SDKROOT CFLAGS CXXFLAGS CPPFLAGS LDFLAGS
export LC_ALL=C
export SOURCE_DATE_EPOCH=1616074138
mkdir -p -- "$BUILD_DIR" "$(dirname -- "$OUTPUT")"
WORK=$(mktemp -d "$BUILD_DIR/ffi-ia32.XXXXXXXX")
printf 'Build work: %s\n' "$WORK"
python3 "$INPUTS/assemble.py" unpack --work "$WORK" --electron-source "$ELECTRON_SOURCE" --archives "$ARCHIVES"

SOURCES=$WORK/sources
FFI=$SOURCES/ffi-napi
DEPS=$SOURCES/node_modules
REF=$DEPS/ref-napi
LIBFFI=$FFI/deps/libffi
HEADERS=$WORK/headers/include/node
mkdir -p -- "$WORK/objects/libffi" "$WORK/objects/ffi" "$WORK/objects/ref" \
  "$FFI/build/Release" "$REF/build/Release"

TARGET=(
  --target=i686-linux-gnu -m32 --sysroot="$SYSROOT"
  --gcc-toolchain="$SYSROOT/usr"
  -B"$GCC_RUNTIME/" -B"$SYSROOT/usr/lib/i386-linux-gnu/"
)
COMMON=(
  -O2 -fPIC -fno-strict-aliasing -fexceptions -pthread -DNDEBUG -D_GNU_SOURCE
  -D_LARGEFILE_SOURCE -D_FILE_OFFSET_BITS=64
  -isystem "$SYSROOT/usr/include/i386-linux-gnu"
  "-ffile-prefix-map=$WORK=/welink-ffi-build"
  "-ffile-prefix-map=$ELECTRON_SOURCE=/electron-src"
)
CPP=(
  -std=gnu++17 -stdlib=libstdc++ -nostdinc++
  -isystem "$SYSROOT/usr/include/c++/10"
  -isystem "$SYSROOT/usr/include/i386-linux-gnu/c++/10"
  -isystem "$SYSROOT/usr/include/c++/10/backward"
  -I "$HEADERS" -I "$DEPS/node-addon-api"
  -I "$DEPS/get-symbol-from-current-process-h/include"
  -I "$DEPS/get-uv-event-loop-napi-h/include" -I "$REF/include"
)
FFI_INCLUDES=(-I "$LIBFFI/include" -I "$LIBFFI/config/linux/ia32")
LINK=(
  --ld-path="$LLVM/ld.lld" -shared -pthread
  -L "$GCC_RUNTIME" -L "$SYSROOT/usr/lib/i386-linux-gnu"
  -L "$SYSROOT/lib/i386-linux-gnu"
  -Wl,-z,relro,-z,now,-z,noexecstack
)

# Source list and defines are the upstream libffi.gyp Linux ia32 branch.
# Preserve the node-addon-api node_api.gyp dependency, whose nothing.c is empty.
"$LLVM/clang" "${TARGET[@]}" "${COMMON[@]}" -c "$DEPS/node-addon-api/nothing.c" -o "$WORK/objects/nothing.o"

LIBFFI_OBJECTS=()
for source in prep_cif.c types.c raw_api.c java_raw_api.c closures.c x86/ffi.c x86/sysv.S; do
  object=$WORK/objects/libffi/${source//\//_}.o
  "$LLVM/clang" "${TARGET[@]}" "${COMMON[@]}" "${FFI_INCLUDES[@]}" \
    -DPIC -DFFI_BUILDING -DHAVE_CONFIG_H -c "$LIBFFI/src/$source" -o "$object"
  LIBFFI_OBJECTS+=("$object")
done

"$LLVM/clang++" "${TARGET[@]}" "${COMMON[@]}" "${CPP[@]}" \
  -DNODE_GYP_MODULE_NAME=binding -c "$REF/src/binding.cc" -o "$WORK/objects/ref/binding.o"
"$LLVM/clang++" "${TARGET[@]}" "${LINK[@]}" "$WORK/objects/nothing.o" "$WORK/objects/ref/binding.o" \
  -ldl -o "$REF/build/Release/binding.node"

FFI_OBJECTS=()
for source in ffi.cc callback_info.cc threaded_callback_invokation.cc; do
  object=$WORK/objects/ffi/$source.o
  "$LLVM/clang++" "${TARGET[@]}" "${COMMON[@]}" "${CPP[@]}" "${FFI_INCLUDES[@]}" \
    -DNODE_GYP_MODULE_NAME=ffi_bindings -c "$FFI/src/$source" -o "$object"
  FFI_OBJECTS+=("$object")
done
"$LLVM/clang++" "${TARGET[@]}" "${LINK[@]}" \
  "$WORK/objects/nothing.o" "${FFI_OBJECTS[@]}" "${LIBFFI_OBJECTS[@]}" -ldl -o "$FFI/build/Release/ffi_bindings.node"

# Stage beside the destination so publication is one same-filesystem rename.
# Only our newly created staging directory is removed on an assembly failure.
PUBLISH=$(mktemp -d "$(dirname -- "$OUTPUT")/.ffi-runtime.XXXXXXXX")
trap 'if [[ -n "${PUBLISH:-}" ]]; then rm -rf -- "$PUBLISH"; fi' EXIT
python3 "$INPUTS/assemble.py" install --work "$WORK" --output "$PUBLISH"
[[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] || die "Output appeared during build: $OUTPUT"
mv -T -- "$PUBLISH" "$OUTPUT"
PUBLISH=
printf 'Native FFI runtime assembled: %s\n' "$OUTPUT"
printf 'Apply the parent library.js override only after assembly. No addon was executed.\n'
