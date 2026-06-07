package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// helper: build a server backed by a fresh temp dir.
func newTestServer(t *testing.T, maxBytes int64) http.Handler {
	t.Helper()
	dir := t.TempDir()
	return newServer(dir, maxBytes, "https://paste.example")
}

// do issues a request against the handler and returns the response recorder.
func do(t *testing.T, h http.Handler, method, target string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, target, r)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestPutThenGetRoundtrip(t *testing.T) {
	h := newTestServer(t, 1<<20)
	want := []byte("print('hello kelp')\n")

	put := do(t, h, http.MethodPut, "/kelp", want)
	if put.Code != http.StatusCreated {
		t.Fatalf("PUT new slot: got %d, want %d", put.Code, http.StatusCreated)
	}

	get := do(t, h, http.MethodGet, "/kelp", nil)
	if get.Code != http.StatusOK {
		t.Fatalf("GET: got %d, want 200", get.Code)
	}
	if !bytes.Equal(get.Body.Bytes(), want) {
		t.Fatalf("GET body: got %q, want %q", get.Body.Bytes(), want)
	}
}

func TestOverwriteReplacesContent(t *testing.T) {
	h := newTestServer(t, 1<<20)
	do(t, h, http.MethodPut, "/kelp", []byte("v1"))

	put := do(t, h, http.MethodPut, "/kelp", []byte("v2-updated"))
	if put.Code != http.StatusOK {
		t.Fatalf("PUT overwrite: got %d, want 200", put.Code)
	}

	get := do(t, h, http.MethodGet, "/kelp", nil)
	if got := get.Body.String(); got != "v2-updated" {
		t.Fatalf("after overwrite: got %q, want %q", got, "v2-updated")
	}
}

func TestBinarySafe(t *testing.T) {
	h := newTestServer(t, 1<<20)
	want := []byte{0x00, 0x01, 0xff, 0xfe, 0x0a, 0x7f, 0x80}
	do(t, h, http.MethodPut, "/blob", want)

	get := do(t, h, http.MethodGet, "/blob", nil)
	if !bytes.Equal(get.Body.Bytes(), want) {
		t.Fatalf("binary roundtrip: got %v, want %v", get.Body.Bytes(), want)
	}
}

func TestDeleteThenGet404(t *testing.T) {
	h := newTestServer(t, 1<<20)
	do(t, h, http.MethodPut, "/kelp", []byte("x"))

	del := do(t, h, http.MethodDelete, "/kelp", nil)
	if del.Code != http.StatusNoContent {
		t.Fatalf("DELETE: got %d, want 204", del.Code)
	}

	get := do(t, h, http.MethodGet, "/kelp", nil)
	if get.Code != http.StatusNotFound {
		t.Fatalf("GET after delete: got %d, want 404", get.Code)
	}
}

func TestDeleteMissing404(t *testing.T) {
	h := newTestServer(t, 1<<20)
	del := do(t, h, http.MethodDelete, "/nope", nil)
	if del.Code != http.StatusNotFound {
		t.Fatalf("DELETE missing: got %d, want 404", del.Code)
	}
}

func TestGetMissing404(t *testing.T) {
	h := newTestServer(t, 1<<20)
	get := do(t, h, http.MethodGet, "/nope", nil)
	if get.Code != http.StatusNotFound {
		t.Fatalf("GET missing: got %d, want 404", get.Code)
	}
}

func TestInvalidIDRejected(t *testing.T) {
	h := newTestServer(t, 1<<20)
	bad := []string{
		"/..",
		"/.",
		"/foo/bar",                     // slash → subpath
		"/foo..bar",                    // contains ..
		"/a%20b",                       // space (encoded) → decodes to "a b"
		"/" + strings.Repeat("x", 129), // too long
	}
	for _, target := range bad {
		rec := do(t, h, http.MethodPut, target, []byte("data"))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("PUT %q: got %d, want 400", target, rec.Code)
		}
	}
}

func TestEmptyIDRejected(t *testing.T) {
	h := newTestServer(t, 1<<20)
	// PUT to root is not a valid slot write.
	rec := do(t, h, http.MethodPut, "/", []byte("data"))
	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT /: got %d, want 400 or 405", rec.Code)
	}
}

func TestNoTraversalEscapesDataDir(t *testing.T) {
	h := newTestServer(t, 1<<20)
	// even if it parsed, this must never write outside the data dir.
	rec := do(t, h, http.MethodPut, "/..%2f..%2fetc%2fpasswd", []byte("pwned"))
	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusNotFound {
		t.Fatalf("traversal attempt: got %d, want 400/404", rec.Code)
	}
}

func TestOversizeBody413(t *testing.T) {
	h := newTestServer(t, 8) // 8-byte cap
	rec := do(t, h, http.MethodPut, "/big", []byte("0123456789"))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize PUT: got %d, want 413", rec.Code)
	}
}

func TestGetSetsNoStore(t *testing.T) {
	h := newTestServer(t, 1<<20)
	do(t, h, http.MethodPut, "/kelp", []byte("x"))
	get := do(t, h, http.MethodGet, "/kelp", nil)
	if cc := get.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control: got %q, want no-store", cc)
	}
}

func TestGetContentTypePlain(t *testing.T) {
	h := newTestServer(t, 1<<20)
	do(t, h, http.MethodPut, "/kelp", []byte("x"))
	get := do(t, h, http.MethodGet, "/kelp", nil)
	if ct := get.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("Content-Type: got %q, want text/plain*", ct)
	}
}

func TestPutEchoesURL(t *testing.T) {
	h := newTestServer(t, 1<<20)
	put := do(t, h, http.MethodPut, "/kelp", []byte("x"))
	body := strings.TrimSpace(put.Body.String())
	if body != "https://paste.example/kelp" {
		t.Fatalf("PUT echo: got %q, want %q", body, "https://paste.example/kelp")
	}
}

func TestHealthz(t *testing.T) {
	h := newTestServer(t, 1<<20)
	get := do(t, h, http.MethodGet, "/healthz", nil)
	if get.Code != http.StatusOK {
		t.Fatalf("healthz: got %d, want 200", get.Code)
	}
}

func TestRootHelp(t *testing.T) {
	h := newTestServer(t, 1<<20)
	get := do(t, h, http.MethodGet, "/", nil)
	if get.Code != http.StatusOK {
		t.Fatalf("root help: got %d, want 200", get.Code)
	}
	if !strings.Contains(get.Body.String(), "PUT") {
		t.Fatalf("root help should document PUT, got %q", get.Body.String())
	}
}

func TestHeadOnExisting(t *testing.T) {
	h := newTestServer(t, 1<<20)
	do(t, h, http.MethodPut, "/kelp", []byte("hello"))
	head := do(t, h, http.MethodHead, "/kelp", nil)
	if head.Code != http.StatusOK {
		t.Fatalf("HEAD: got %d, want 200", head.Code)
	}
	if head.Body.Len() != 0 {
		t.Fatalf("HEAD body should be empty, got %d bytes", head.Body.Len())
	}
}
