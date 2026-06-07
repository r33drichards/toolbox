# paste — mutable key→bytes store

A tiny Go service (stdlib only, single static binary, `FROM scratch` image)
that stores **named, overwritable** slots. Unlike a classic pastebin, a slot
has a stable URL you can rewrite in place — so a poller hot-reloads whatever
you last `PUT`.

Built for the ComputerCraft hot-reload loop: a turtle's `http.get(url)` fetches
the latest program every tick, and you ship a new version with one `curl -T`.
It's the **mutable program store** companion to the immutable GhostBin output
sink in this project.

## API

| Method | Path     | Effect                                              | Codes |
|--------|----------|-----------------------------------------------------|-------|
| `PUT`  | `/<id>`  | create or overwrite slot (request body = content)   | `201` new / `200` replaced |
| `POST` | `/<id>`  | same as PUT                                          | `201` / `200` |
| `GET`  | `/<id>`  | raw bytes, `Content-Type: text/plain`, `Cache-Control: no-store` | `200` / `404` |
| `HEAD` | `/<id>`  | headers only                                        | `200` / `404` |
| `DELETE`| `/<id>` | remove slot                                         | `204` / `404` |
| `GET`  | `/`      | usage help                                          | `200` |
| `GET`  | `/healthz`| liveness                                           | `200` |

`id` must match `^[A-Za-z0-9._-]{1,128}$` — no slashes, no `..` (path traversal
is rejected with `400`). Reads are anonymous; **there is no write auth** (see
below to add one). Bodies are capped at `MAX_BYTES` (default 1 MiB) → `413`.

## Examples

```sh
URL=https://paste-production.up.railway.app

# create / overwrite the program a turtle runs
curl -T program.lua $URL/kelp        # -> 201/200, echoes $URL/kelp

# what the turtle does each loop (raw, never cached)
curl $URL/kelp

# update in place — turtle picks it up next tick
curl -T program-v2.lua $URL/kelp

# remove it
curl -X DELETE $URL/kelp
```

## Config (env)

| Var          | Default   | Meaning                                        |
|--------------|-----------|------------------------------------------------|
| `PORT`       | `8080`    | listen port (Railway injects this)             |
| `DATA_DIR`   | `/data`   | where slots are stored (mount a volume here)   |
| `MAX_BYTES`  | `1048576` | max request body size                          |
| `PUBLIC_URL` | *(unset)* | base URL echoed by PUT; falls back to request `Host` + `X-Forwarded-Proto` |

## Run locally

```sh
docker build -t paste .
docker run -p 8080:8080 -v paste-data:/data paste
```

or without Docker:

```sh
DATA_DIR=./data PORT=8080 go run .
```

## Deploy on Railway

1. New service in the toolbox project → deploy from this repo, **root directory `paste/`** (or set `dockerfilePath`/`railway.json` accordingly).
2. **Add a Volume mounted at `/data`.** Without it the store is ephemeral and slots are lost on every redeploy. (Railway volumes mount at runtime; build-time writes to `/data` do not persist.)
3. Optionally set `PUBLIC_URL` to the service's public domain so `PUT` echoes the right URL.
4. Healthcheck path is `/healthz` (preset in `railway.json`).

## Adding write auth later

Writes are open by design. To gate them, add at the top of `handlePut`:

```go
if tok := os.Getenv("WRITE_TOKEN"); tok != "" && r.Header.Get("Authorization") != "Bearer "+tok {
    http.Error(w, "unauthorized", http.StatusUnauthorized)
    return
}
```

then set `WRITE_TOKEN` in Railway and pass `-H "Authorization: Bearer <tok>"`
on `curl -T`/`DELETE`. Reads stay anonymous so `http.get` keeps working.

## Tests

```sh
go test ./...
```
