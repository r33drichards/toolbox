#!/usr/bin/env bash
# Download third-party language engines into vendor/.
# Used by the Dockerfile and for local development. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p vendor

# Pinned versions
BABEL_VERSION=7.26.4
REACT_VERSION=18.3.1
MARKED_VERSION=11.1.1
MERMAID_VERSION=9.4.3
MINIZINC_VERSION=4.4.6
WASMOON_VERSION=1.16.0
ACADLISP_SHA=aa555bbe87f950ceceb8cb587c0735bc69aa2f23
ACADLISP_HASH=86aa022a7657981b

dl() { # dl <url> <dest>
    if [ ! -s "vendor/$2" ]; then
        echo "fetching $2"
        curl -fsSL "$1" -o "vendor/$2"
    fi
}

# Pure-JS engines (UMD builds)
dl "https://unpkg.com/@babel/standalone@${BABEL_VERSION}/babel.min.js" babel.min.js
dl "https://unpkg.com/react@${REACT_VERSION}/umd/react.production.min.js" react.min.js
dl "https://unpkg.com/react-dom@${REACT_VERSION}/umd/react-dom-server-legacy.browser.production.min.js" react-dom-server.min.js
dl "https://cdn.jsdelivr.net/npm/marked@${MARKED_VERSION}/marked.min.js" marked.min.js
dl "https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js" mermaid.min.js

# AutoLISP (acadlisp, wasm-bindgen)
dl "https://cdn.jsdelivr.net/gh/holg/acadlisp@${ACADLISP_SHA}/dist/acadlisp-${ACADLISP_HASH}.js" acadlisp.js
dl "https://cdn.jsdelivr.net/gh/holg/acadlisp@${ACADLISP_SHA}/dist/acadlisp-${ACADLISP_HASH}_bg.wasm" acadlisp.wasm

# MiniZinc (Emscripten worker bundle + stdlib data + wasm)
if [ ! -s vendor/minizinc.wasm ]; then
    echo "fetching minizinc ${MINIZINC_VERSION}"
    curl -fsSL "https://registry.npmjs.org/minizinc/-/minizinc-${MINIZINC_VERSION}.tgz" -o vendor/minizinc.tgz
    tar -xzf vendor/minizinc.tgz -C vendor package/dist/minizinc-worker.js package/dist/minizinc.data package/dist/minizinc.wasm
    mv vendor/package/dist/minizinc-worker.js vendor/minizinc-worker.js
    mv vendor/package/dist/minizinc.data vendor/minizinc.data
    mv vendor/package/dist/minizinc.wasm vendor/minizinc.wasm
    rm -rf vendor/package vendor/minizinc.tgz
fi

# Lua (wasmoon — Lua 5.4 compiled to wasm via Emscripten + JS wrapper)
# Ships dist/index.js (UMD bundle: glue + LuaFactory/LuaEngine wrappers) and
# dist/glue.wasm (the Lua VM). We vendor them as wasmoon.js and lua.wasm.
if [ ! -s vendor/lua.wasm ]; then
    echo "fetching wasmoon ${WASMOON_VERSION}"
    curl -fsSL "https://registry.npmjs.org/wasmoon/-/wasmoon-${WASMOON_VERSION}.tgz" -o vendor/wasmoon.tgz
    tar -xzf vendor/wasmoon.tgz -C vendor package/dist/index.js package/dist/glue.wasm
    mv vendor/package/dist/index.js vendor/wasmoon.js
    mv vendor/package/dist/glue.wasm vendor/lua.wasm
    rm -rf vendor/package vendor/wasmoon.tgz
fi

# Picat + TLA+ wasm builds are vendored in this repo under engines/
# (Picat engine source: github.com/r33drichards/Picat, branch wasm-build;
# wasm builds originate from the r33drichards/pastebin project).
for f in picat.mjs picat.wasm tla_checker.js tla_checker.wasm; do
    cp -f "engines/$f" "vendor/$f"
done

echo "vendor/ ready:"
ls -la vendor/
