# paste — mutable key->bytes store, FROM scratch like the rest of toolbox.
#
# Build:  docker build -t paste .
# Run:    docker run -p 8080:8080 -v paste-data:/data paste
#   PUT:  curl -T file.lua http://localhost:8080/kelp
#   GET:  curl http://localhost:8080/kelp
#
# On Railway, mount a Volume at /data — the filesystem is otherwise ephemeral
# and slots vanish on redeploy. Build-time writes do NOT persist (volumes
# mount at runtime only), so the empty /data baked here is just the mount point.
# Runs as root: Railway mounts the volume root-owned, so a non-root user gets
# "500 write error" on /data.

# ── Stage 1: build a static binary ─────────────────────────────────────────
FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /paste .
# /data is just the volume mount point; the app MkdirAll's it at runtime.
RUN mkdir -p /data

# ── Stage 2: scratch ───────────────────────────────────────────────────────
FROM scratch
COPY --from=build /paste /paste
COPY --from=build /data /data

ENV DATA_DIR=/data \
    PORT=8080
EXPOSE 8080
ENTRYPOINT ["/paste"]
