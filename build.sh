#!/bin/sh
# Build the WebAssembly package into web/pkg, then serve the page:
#   ./build.sh && python3 -m http.server 8000 --directory web
set -e
. "$HOME/.cargo/env"
wasm-pack build --release --target web --out-dir web/pkg --no-typescript
