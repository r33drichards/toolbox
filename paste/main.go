// paste — a tiny mutable key→bytes store.
//
// Named slots you can overwrite in place, so a poller (e.g. a ComputerCraft
// turtle's http.get) hot-reloads whatever you last PUT:
//
//	curl -T program.lua  https://host/kelp     # create or overwrite
//	curl                 https://host/kelp     # raw read (anonymous)
//	curl -X DELETE       https://host/kelp     # remove
//
// Storage is one flat file per slot under DATA_DIR. Reads are public; there
// is no write auth (add an env-gated token check in handlePut if you want one).
package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var idRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// validateID enforces a safe, single-segment slot name. Anything that could
// escape DATA_DIR (slashes, "..") or is empty/over-long is rejected.
func validateID(id string) error {
	if id == "" {
		return fmt.Errorf("empty id")
	}
	if len(id) > 128 {
		return fmt.Errorf("id too long")
	}
	if id == "." || id == ".." || strings.Contains(id, "..") {
		return fmt.Errorf("illegal id")
	}
	if strings.ContainsRune(id, '/') {
		return fmt.Errorf("id may not contain '/'")
	}
	if !idRe.MatchString(id) {
		return fmt.Errorf("id must match [A-Za-z0-9._-]")
	}
	return nil
}

type server struct {
	dataDir   string
	maxBytes  int64
	publicURL string // e.g. https://paste.example ; if "", derived from request
}

func newServer(dataDir string, maxBytes int64, publicURL string) http.Handler {
	return &server{
		dataDir:   dataDir,
		maxBytes:  maxBytes,
		publicURL: strings.TrimRight(publicURL, "/"),
	}
}

const rootHelp = `paste — mutable key->bytes store

  PUT    /<id>   create or overwrite a slot (request body = content)
  GET    /<id>   read the raw bytes (anonymous, Cache-Control: no-store)
  DELETE /<id>   remove a slot

  id must match [A-Za-z0-9._-], max 128 chars.

  curl -T program.lua  $URL/kelp     # write
  curl                 $URL/kelp     # read
  curl -X DELETE       $URL/kelp     # delete
`

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz":
		w.Header().Set("Cache-Control", "no-store")
		io.WriteString(w, "ok\n")
		return
	case "/":
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			if r.Method == http.MethodGet {
				io.WriteString(w, rootHelp)
			}
			return
		}
		http.Error(w, "method not allowed on /", http.StatusMethodNotAllowed)
		return
	}

	id := strings.TrimPrefix(r.URL.Path, "/")
	if err := validateID(id); err != nil {
		http.Error(w, "bad id: "+err.Error(), http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet, http.MethodHead:
		s.handleGet(w, r, id)
	case http.MethodPut, http.MethodPost:
		s.handlePut(w, r, id)
	case http.MethodDelete:
		s.handleDelete(w, r, id)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) path(id string) string { return filepath.Join(s.dataDir, id) }

func (s *server) handleGet(w http.ResponseWriter, r *http.Request, id string) {
	data, err := os.ReadFile(s.path(id))
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if r.Method == http.MethodHead {
		return
	}
	w.Write(data)
}

func (s *server) handlePut(w http.ResponseWriter, r *http.Request, id string) {
	// read at most maxBytes+1 so we can detect overflow.
	body, err := io.ReadAll(io.LimitReader(r.Body, s.maxBytes+1))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	if int64(len(body)) > s.maxBytes {
		http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		return
	}

	existed := false
	if _, err := os.Stat(s.path(id)); err == nil {
		existed = true
	}

	if err := s.writeAtomic(id, body); err != nil {
		http.Error(w, "write error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if existed {
		w.WriteHeader(http.StatusOK)
	} else {
		w.WriteHeader(http.StatusCreated)
	}
	fmt.Fprintln(w, s.urlFor(r, id))
}

// writeAtomic writes to a temp file in the data dir then renames over the
// target, so a concurrent reader never sees a partial program.
func (s *server) writeAtomic(id string, data []byte) error {
	tmp, err := os.CreateTemp(s.dataDir, ".tmp-"+id+"-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, s.path(id))
}

func (s *server) handleDelete(w http.ResponseWriter, r *http.Request, id string) {
	if err := os.Remove(s.path(id)); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// urlFor builds the public URL echoed back on PUT.
func (s *server) urlFor(r *http.Request, id string) string {
	if s.publicURL != "" {
		return s.publicURL + "/" + id
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	}
	return scheme + "://" + r.Host + "/" + id
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	dataDir := env("DATA_DIR", "/data")
	port := env("PORT", "8080")
	publicURL := env("PUBLIC_URL", "")

	maxBytes := int64(1 << 20) // 1 MiB
	if v := os.Getenv("MAX_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			maxBytes = n
		}
	}

	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("cannot create data dir %s: %v", dataDir, err)
	}

	h := newServer(dataDir, maxBytes, publicURL)
	addr := ":" + port
	log.Printf("paste listening on %s, data=%s, maxBytes=%d", addr, dataDir, maxBytes)
	log.Fatal(http.ListenAndServe(addr, h))
}
