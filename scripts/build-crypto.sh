#!/bin/sh
# Builds Chat's MLS module (crypto/chat-mls) into src/lib/chat/mls-module/,
# which Git ignores. Needs the Rust of crypto/chat-mls/rust-toolchain.toml with
# its WebAssembly target, and wasm-bindgen (scripts/install-wasm-bindgen.sh).
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/crypto/chat-mls"
# The build machine's folders stay out of the module, so every machine builds the same file.
RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$root=/unihub" \
  cargo build --locked --release --target wasm32-unknown-unknown
# --experimental-reset-state-function: a module that trapped starts again with fresh memory (src/lib/chat/mls.ts).
wasm-bindgen --target web --experimental-reset-state-function --out-dir "$root/src/lib/chat/mls-module" \
  "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/chat_mls.wasm"
if grep -aqF -e "$root/crypto" -e "${CARGO_HOME:-$HOME/.cargo}/registry" "$root/src/lib/chat/mls-module/chat_mls_bg.wasm"; then
  echo "The module holds a path of this machine, so other machines would build another file." >&2; exit 1
fi
