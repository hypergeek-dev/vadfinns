package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExecutableServesBundledLibrary(t *testing.T) {
	srv, err := newServer(t.TempDir(), "test-password-long", "test-session-secret-that-is-long-enough", false)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	srv.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/foods?available=true", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	var body struct {
		Foods []PublicFood `json:"foods"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Foods) != 19 {
		t.Fatalf("foods = %d, want 19", len(body.Foods))
	}
}

func TestAdminRequiresAuthentication(t *testing.T) {
	srv, err := newServer(t.TempDir(), "test-password-long", "test-session-secret-that-is-long-enough", false)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	srv.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/api/admin/foods/missing", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestPasswordlessLocalAdmin(t *testing.T) {
	srv, err := newServer(t.TempDir(), "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/admin/session", nil)
	request.RemoteAddr = "127.0.0.1:54321"
	srv.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
}
