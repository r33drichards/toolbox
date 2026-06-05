# toolbox — an MCP server with seven languages in one container

A Docker image that runs [mcp-js / mcp-v8](https://github.com/r33drichards/mcp-js)
(a V8 JavaScript MCP server) in **Streamable HTTP MCP mode** with **fetch
enabled everywhere** and seven language engines loaded into the runtime:

| helper | engine | kind |
|---|---|---|
| `await picat(code, args?)` | Picat 3.9 (full engine: planner, tabling, CP, SAT/kissat) | wasm |
| `await tlaplus(spec, opts?)` | TLA+ model checker (supports inline `---- CONFIG ----`) | wasm |
| `await minizinc(model, {data?, args?})` | MiniZinc 4.4.6 (gecode/chuffed) | wasm |
| `await autolisp(code)` | acadlisp (returns evaluated result + SVG drawing) | wasm |
| `jsx(source, props?)` | Babel + React 18 server render → HTML | js |
| `markdown(src)` | marked 11 (GFM) → HTML | js |
| `await mermaid_parse(src)` | mermaid 9 parse/validate (render needs a real DOM) | js |

`languages()` returns the manifest. All helpers return plain JSON objects.

## Run

```sh
docker build -t toolbox .
docker run -p 3000:3000 toolbox
# or
docker compose up --build
```

- MCP endpoint (Streamable HTTP): `http://localhost:3000/mcp`
- Plain REST: `POST /api/exec`, `GET /api/executions/{id}`, `/swagger-ui`

## Use

Every execution is a fresh V8 isolate (stateless mode — see "why stateless"
below). Load the languages at the top of a run with the one-line loader — the
6.7MB bootstrap ships in the image and is read through the policy-gated `fs`
module (read-only on `/opt/languages/`):

```js
(0, eval)(await fs.readFile('/opt/languages/bootstrap.js'));

const q = await picat('import cp. main => ...');
console.log(q.stdout);
```

### Light client

`client.mjs` is a dependency-free MCP Streamable-HTTP client (node ≥ 18):

```sh
node client.mjs tools
LANG_BOOTSTRAP_URL=/opt/languages/bootstrap.js \
  node client.mjs run 'const r = await picat("main => println(42)."); console.log(r.stdout)'
node client.mjs run-file ./script.js     # MCP_URL=... to point elsewhere
```

With `LANG_BOOTSTRAP_URL` set (a container path read via `fs`, or an
http(s) URL fetched by the server's runtime), the loader prelude is
prepended automatically.

### Tests

```sh
node test.mjs        # MCP_URL=http://localhost:3000/mcp by default
```

32 checks: MCP protocol + TypeScript stripping, fetch-anywhere, bootstrap
manifest, Picat (hello / CP 8-queens / SAT / full turtle-quarry planner /
error paths), TLA+ (pass + invariant violation with trace), MiniZinc
(satisfy / optimize / UNSAT / error), AutoLISP (SVG entities + princ +
arithmetic), JSX, Markdown, mermaid (2 diagram types + parse error), and
3-way concurrency.

## How it fits together

```
Dockerfile            three-stage: node (vendor+generate) → debian (rootfs assembly) → scratch
fetch.rego            OPA policy: default allow = true  ("fetch anywhere")
filesystem.rego       OPA policy: read-only fs access to /opt/languages/
fetch-vendor.sh       pinned downloads (babel, react, marked, mermaid, minizinc, acadlisp)
engines/              vendored Picat + TLA+ wasm builds
build-bootstrap.mjs   vendor/* + src/* → bootstrap.js (single eval-able script)
src/polyfills.js      TextDecoder/TextEncoder/URL/performance/DOM-stub for bare deno_core
src/helpers.js        the seven language helper functions
client.mjs            light MCP client (library + CLI)
test.mjs              exhaustive test suite
examples/turtle_quarry.pi
```

The final image is **`FROM scratch`** — just the files: the mcp-v8 release
binary, the handful of glibc libraries it links against (plus the NSS DNS
libs and `nsswitch.conf`, without which `fetch()` could not resolve
hostnames), CA certificates, the four `.wasm` engines, `bootstrap.js`, and
the two Rego policies. No shell, no package manager. The server runs
directly as PID 1 via an exec-form ENTRYPOINT.

- The four wasm engines are **preloaded by the server** (`--wasm-module
  name=path:limit`) and appear as precompiled `WebAssembly.Module` globals
  (`__wasm_picat`, `__wasm_tla`, `__wasm_minizinc`, `__wasm_autolisp`).
  The helpers instantiate them per call (Picat via Emscripten's
  `instantiateWasm` hook, TLA+/acadlisp via wasm-bindgen `initSync({module})`,
  MiniZinc by driving its worker bundle with shimmed `addEventListener`/
  `postMessage`/`fetch` and a temporary `WebAssembly.instantiateStreaming`
  override).
- MiniZinc's 495KB stdlib `.data` file is embedded in the bootstrap as
  base64 because mcp-v8's `fetch()` decodes bodies as UTF-8 text (lossy for
  binary).
- The bootstrap is loaded via `fs.readFile` rather than POSTed with the
  code because the HTTP body limit is ~2MB and the bootstrap is 6.7MB.
- Engine provenance: the Picat wasm engine is built from
  [r33drichards/Picat](https://github.com/r33drichards/Picat) (branch
  `wasm-build`); both it and the TLA+ checker wasm come from the
  r33drichards/pastebin project and are vendored under `engines/`.

## Why stateless?

V8 cannot create heap snapshots from isolates that have WebAssembly objects
injected — with `--wasm-module` configured, stateful mode fails every
execution with `WebAssembly is not an object` (the module injection happens
inside the snapshot-creator isolate). Stateless mode + per-run bootstrap
loading (~1s overhead) is the working configuration.

## Changing server flags

The scratch image has no shell, so there are no env-var knobs — the full
command line lives in the exec-form ENTRYPOINT (port 3000, 1024MB V8 heap,
300s timeout, all four `--wasm-module` flags). To change a flag, override
the entrypoint:

```sh
docker run -p 4000:4000 --entrypoint /usr/local/bin/mcp-v8 toolbox \
  --http-port 4000 --stateless --allow-external-modules \
  --policies-json '{"fetch":{"policies":[{"url":"file:///opt/languages/fetch.rego"}]},"filesystem":{"policies":[{"url":"file:///opt/languages/filesystem.rego"}]}}' \
  --wasm-module picat=/opt/languages/picat.wasm:512m \
  --wasm-module tla=/opt/languages/tla_checker.wasm:512m \
  --wasm-module minizinc=/opt/languages/minizinc.wasm:1g \
  --wasm-module autolisp=/opt/languages/acadlisp.wasm:512m
```
