#!/bin/sh
# Writes the licence notices of the crates built into Chat's MLS module to $1.
set -eu
cd "$(dirname "$0")/chat-mls"
registry="${CARGO_HOME:-$HOME/.cargo}/registry/src"
{
  printf 'Chat encryption (crypto/chat-mls) dependency notices\n\nGenerated from crypto/chat-mls/Cargo.lock and the crates it built.\n'
  cargo tree --locked --target wasm32-unknown-unknown --edges normal --prefix none --format '{p}|{l}' | sed 's/ (\*)$//' | sort -u | while IFS='|' read -r package licence; do
    set -- $package
    [ "$1" = chat-mls ] && continue
    printf '\n---\n%s %s\nLicense: %s\n' "$1" "$2" "$licence"
    for file in "$registry"/*/"$1-${2#v}"/*; do
      case "$(basename "$file")" in [Ll][Ii][Cc][Ee][Nn][CcSs][Ee]*|[Cc][Oo][Pp][Yy][Ii][Nn][Gg]*|[Nn][Oo][Tt][Ii][Cc][Ee]*) printf '\n%s\n' "$(basename "$file")"; cat "$file" ;; esac
    done
  done
} > "$1"
