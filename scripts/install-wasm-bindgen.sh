#!/bin/sh
# Installs the wasm-bindgen command line tool into the folder $1. Its version
# must be the one crypto/chat-mls/Cargo.lock pins (wasm-bindgen refuses others).
set -eu
version=0.2.130
case "$(uname -m)" in
  x86_64) sum=9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f ;;
  aarch64) sum=99ffc93ce80081b91632e2b539b782821a8f3439ab0fddc645287462b2f55d3d ;;
  *) echo "No wasm-bindgen release for $(uname -m)" >&2; exit 1 ;;
esac
name="wasm-bindgen-$version-$(uname -m)-unknown-linux-musl"
mkdir -p "$1"
wget -q -O "$1/$name.tar.gz" "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$version/$name.tar.gz"
echo "$sum  $1/$name.tar.gz" | sha256sum -c -
tar -xzf "$1/$name.tar.gz" -C "$1"
mv "$1/$name/wasm-bindgen" "$1/wasm-bindgen"
rm -rf "$1/$name" "$1/$name.tar.gz"
