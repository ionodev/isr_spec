#!/bin/sh
# Stamps every asset URL of the built page with a version (the commit), so a
# browser cannot combine cached files of an older version with newer ones.
# Usage: tools/version_assets.sh VERSION   (run after the WebAssembly build)
set -e
v="$1"
cd "$(dirname "$0")/../web"
sed -i "s/?v=dev/?v=$v/g" index.html
# relative module imports and data files
sed -i -E "s#(from \"\./[^\"]+\.js)\"#\1?v=$v\"#g; s#\"tex/glyphs\.json\"#\"tex/glyphs.json?v=$v\"#" app.js figure.js tex.js
sed -i "s#isr_spec_web_bg\.wasm'#isr_spec_web_bg.wasm?v=$v'#; s#isr_spec_web_bg\.wasm\"#isr_spec_web_bg.wasm?v=$v\"#" pkg/isr_spec_web.js
