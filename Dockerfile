# toolbox — mcp-v8 (r33drichards/mcp-js) in HTTP MCP mode with eight
# languages loaded: picat, tla+, minizinc, autolisp, lua, jsx, markdown, mermaid.
#
# Final image is FROM scratch: just the mcp-v8 binary, the glibc libraries
# it links against, CA certs, and the language assets. No shell, no
# coreutils, no package manager. Executions load the bootstrap through the
# policy-gated fs module: (0, eval)(await fs.readFile('/opt/languages/bootstrap.js'))
#
# Build:  docker build -t toolbox .
# Run:    docker run -p 3000:3000 toolbox
# MCP endpoint:  http://localhost:3000/mcp   (Streamable HTTP)
# REST API:      http://localhost:3000/api/exec, /swagger-ui

# ── Stage 1: vendor + generate bootstrap.js ────────────────────────────────
FROM node:22-bookworm-slim AS gen
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY fetch-vendor.sh build-bootstrap.mjs ./
COPY src ./src
COPY engines ./engines
RUN ./fetch-vendor.sh
RUN node build-bootstrap.mjs /build/bootstrap.js

# ── Stage 2: assemble a minimal rootfs for the scratch image ───────────────
FROM debian:bookworm-slim AS rootfs

ARG MCP_V8_VERSION=v0.11.0
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Prebuilt mcp-v8 release binary (linux x86_64 / arm64)
RUN case "${TARGETARCH}" in \
        arm64) suffix="-arm64" ;; \
        *) suffix="" ;; \
    esac \
    && curl -fsSL "https://github.com/r33drichards/mcp-js/releases/download/${MCP_V8_VERSION}/mcp-v8-linux${suffix}.gz" \
       | gunzip > /mcp-v8 \
    && chmod +x /mcp-v8

# Collect everything the binary needs at its expected paths:
#  - the ELF interpreter (ld-linux) and linked glibc libraries (from ldd)
#  - NSS libraries + nsswitch.conf (glibc resolves DNS through these;
#    without them fetch() cannot resolve hostnames in a scratch image)
#  - CA certificates for outbound TLS
#  - writable /tmp for the execution registry (sled)
RUN set -eux; \
    mkdir -p /rootfs/usr/local/bin /rootfs/etc/ssl/certs /rootfs/opt/languages /rootfs/tmp; \
    cp /mcp-v8 /rootfs/usr/local/bin/mcp-v8; \
    ldd /mcp-v8 | awk '$2 == "=>" {print $3} $1 ~ /^\// {print $1}' | sort -u | while read -r lib; do \
        mkdir -p "/rootfs$(dirname "$lib")"; cp "$lib" "/rootfs$lib"; \
    done; \
    for nss in libnss_files libnss_dns libresolv; do \
        for f in /lib/*-linux-gnu*/${nss}.so* /lib/*-linux-gnu*/${nss}-*.so; do \
            [ -e "$f" ] || continue; \
            mkdir -p "/rootfs$(dirname "$f")"; cp "$f" "/rootfs$f"; \
        done; \
    done; \
    echo 'hosts: files dns' > /rootfs/etc/nsswitch.conf; \
    cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/ca-certificates.crt; \
    chown -R 1000:1000 /rootfs/tmp /rootfs/opt/languages

# Language assets
COPY --from=gen /build/bootstrap.js /rootfs/opt/languages/bootstrap.js
COPY --from=gen /build/vendor/picat.wasm /build/vendor/tla_checker.wasm \
                /build/vendor/minizinc.wasm /build/vendor/acadlisp.wasm \
                /build/vendor/lua.wasm /rootfs/opt/languages/
COPY fetch.rego filesystem.rego /rootfs/opt/languages/
RUN chown -R 1000:1000 /rootfs/opt/languages

# ── Stage 3: scratch ───────────────────────────────────────────────────────
FROM scratch

COPY --from=rootfs /rootfs /

USER 1000:1000
EXPOSE 3000

# NOTE: --sse-port (legacy HTTP+SSE transport: GET /sse + POST /message),
# not --http-port. The bundled rmcp 0.1.5 "streamable" transport answers
# POSTed requests with an empty 200 and delivers results on the GET stream,
# which current MCP clients (e.g. Claude's connectors) read as "no tools".
# The SSE transport is the spec generation those clients fully support.
ENTRYPOINT ["/usr/local/bin/mcp-v8", \
  "--sse-port", "3000", \
  "--stateless", \
  "--heap-memory-max", "1024", \
  "--execution-timeout", "300", \
  "--allow-external-modules", \
  "--policies-json", "{\"fetch\":{\"policies\":[{\"url\":\"file:///opt/languages/fetch.rego\"}]},\"filesystem\":{\"policies\":[{\"url\":\"file:///opt/languages/filesystem.rego\"}]}}", \
  "--wasm-module", "picat=/opt/languages/picat.wasm:512m", \
  "--wasm-module", "tla=/opt/languages/tla_checker.wasm:512m", \
  "--wasm-module", "minizinc=/opt/languages/minizinc.wasm:1g", \
  "--wasm-module", "autolisp=/opt/languages/acadlisp.wasm:512m", \
  "--wasm-module", "lua=/opt/languages/lua.wasm:512m"]
