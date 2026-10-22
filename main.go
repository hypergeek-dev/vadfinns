package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

//go:embed public/* assets/*
var bundled embed.FS

const (
	maxUpload  = 12 << 20
	sessionAge = 12 * time.Hour
)

var version = "dev"

type Food struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Order     int    `json:"order"`
	Image     string `json:"image"`
	Thumbnail string `json:"thumbnail"`
	Hash      string `json:"hash"`
}

type PublicFood struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Available    bool   `json:"available"`
	Order        int    `json:"order"`
	ImageURL     string `json:"imageUrl"`
	ThumbnailURL string `json:"thumbnailUrl"`
}

type Store struct {
	mu       sync.RWMutex
	root     string
	mediaDir string
	file     string
	foods    []Food
}

var swedishNames = map[string]string{
	"Classic Spaghetti Bolognese with Parmesan":        "Spagetti med köttfärssås",
	"Creamy Macaroni and Golden Corn":                  "Makaroner och majs",
	"Creamy Yogurt with Chocolate Cereal Balls":        "Yoghurt med chokladflingor",
	"Crispy Buffalo Wings on a Plate":                  "Kycklingvingar",
	"Crispy-Edged Sunny-Side-Up Egg":                   "Stekt ägg",
	"Fresh Apple on White Plate":                       "Äpple",
	"Fresh Peeled Cucumber Slices on Plate":            "Gurka",
	"Glossy Ketchup Hot Dog Close-Up":                  "Korv med bröd",
	"Golden Bacon Egg Stir-Fried Noodles":              "Nudlar med bacon och ägg",
	"Golden Belgian Waffle on White Plate":             "Våffla",
	"Golden Crackling Pork Roast in a Swedish Kitchen": "Fläskstek",
	"Golden Crepe Pancake Stack":                       "Pannkakor",
	"Golden French Fries on a White Plate":             "Pommes frites",
	"Golden Ham and Mozzarella Pizza":                  "Pizza med skinka",
	"Golden-Browned Layered Lasagna Slice":             "Lasagne",
	"Gooey Cheddar Cheeseburger Close-Up":              "Hamburgare",
	"Single Banana on White Plate":                     "Banan",
	"Swedish Meatballs with Mashed Potatoes":           "Köttbullar med potatismos",
	"Turkey on Puffed Rice Cake":                       "Riskaka med kalkon",
}

func newStore(root string) (*Store, error) {
	s := &Store{root: root, mediaDir: filepath.Join(root, "media"), file: filepath.Join(root, "foods.json")}
	if err := os.MkdirAll(s.mediaDir, 0750); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(s.file)
	if err == nil {
		if err := json.Unmarshal(data, &s.foods); err != nil {
			return nil, fmt.Errorf("läser foods.json: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := s.importBundled(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) importBundled() error {
	entries, err := fs.ReadDir(bundled, "assets")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !allowedExtension(filepath.Ext(entry.Name())) {
			continue
		}
		data, err := bundled.ReadFile("assets/" + entry.Name())
		if err != nil {
			return err
		}
		hash := hashBytes(data)
		s.mu.RLock()
		duplicate := s.hasHash(hash, "")
		s.mu.RUnlock()
		if duplicate {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))
		if len(name) > 4 && name[len(name)-4] == ' ' && name[len(name)-3] == '(' && name[len(name)-1] == ')' {
			name = name[:len(name)-4]
		}
		if translated, ok := swedishNames[name]; ok {
			name = translated
		}
		if _, err := s.addImage(data, name, true); err != nil {
			return fmt.Errorf("importerar %s: %w", entry.Name(), err)
		}
	}
	return nil
}

func allowedExtension(ext string) bool {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg", ".png", ".webp":
		return true
	}
	return false
}

func hashBytes(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (s *Store) hasHash(hash, exceptID string) bool {
	for _, food := range s.foods {
		if food.Hash == hash && food.ID != exceptID {
			return true
		}
	}
	return false
}

func resize(src image.Image, max int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= max && h <= max {
		return src
	}
	if w >= h {
		h = h * max / w
		w = max
	} else {
		w = w * max / h
		h = max
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	return dst
}

func writeJPEG(path string, img image.Image, max, quality int) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0640)
	if err != nil {
		return err
	}
	err = jpeg.Encode(f, resize(img, max), &jpeg.Options{Quality: quality})
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func cleanName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Namnlös mat"
	}
	r := []rune(name)
	if len(r) > 80 {
		r = r[:80]
	}
	return string(r)
}

func (s *Store) addImage(data []byte, name string, available bool) (PublicFood, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return PublicFood{}, errors.New("bildformatet stöds inte")
	}
	hash := hashBytes(data)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hasHash(hash, "") {
		return PublicFood{}, duplicateError{}
	}
	id := newID()
	imageName, thumbName := id+".jpg", id+"-thumb.jpg"
	if err := writeJPEG(filepath.Join(s.mediaDir, imageName), img, 1800, 88); err != nil {
		return PublicFood{}, err
	}
	if err := writeJPEG(filepath.Join(s.mediaDir, thumbName), img, 520, 80); err != nil {
		_ = os.Remove(filepath.Join(s.mediaDir, imageName))
		return PublicFood{}, err
	}
	food := Food{ID: id, Name: cleanName(name), Available: available, Order: len(s.foods), Image: imageName, Thumbnail: thumbName, Hash: hash}
	s.foods = append(s.foods, food)
	if err := s.persistLocked(); err != nil {
		return PublicFood{}, err
	}
	return publicFood(food), nil
}

func publicFood(f Food) PublicFood {
	return PublicFood{f.ID, f.Name, f.Available, f.Order, "/media/" + f.Image, "/media/" + f.Thumbnail}
}

func (s *Store) list(availableOnly bool) []PublicFood {
	s.mu.RLock()
	foods := append([]Food(nil), s.foods...)
	s.mu.RUnlock()
	sort.Slice(foods, func(i, j int) bool {
		if foods[i].Order == foods[j].Order {
			return foods[i].Name < foods[j].Name
		}
		return foods[i].Order < foods[j].Order
	})
	out := make([]PublicFood, 0, len(foods))
	for _, food := range foods {
		if !availableOnly || food.Available {
			out = append(out, publicFood(food))
		}
	}
	return out
}

func (s *Store) update(id string, available *bool, name *string) (PublicFood, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.foods {
		if s.foods[i].ID != id {
			continue
		}
		if available != nil {
			s.foods[i].Available = *available
		}
		if name != nil {
			if strings.TrimSpace(*name) == "" {
				return PublicFood{}, true, errors.New("namnet får inte vara tomt")
			}
			s.foods[i].Name = cleanName(*name)
		}
		if err := s.persistLocked(); err != nil {
			return PublicFood{}, true, err
		}
		return publicFood(s.foods[i]), true, nil
	}
	return PublicFood{}, false, nil
}

func (s *Store) move(id, direction string) (PublicFood, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sort.Slice(s.foods, func(i, j int) bool { return s.foods[i].Order < s.foods[j].Order })
	index := -1
	for i := range s.foods {
		if s.foods[i].ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return PublicFood{}, false, nil
	}
	target := index + 1
	if direction == "up" {
		target = index - 1
	}
	if target >= 0 && target < len(s.foods) {
		s.foods[index], s.foods[target] = s.foods[target], s.foods[index]
	}
	for i := range s.foods {
		s.foods[i].Order = i
	}
	if err := s.persistLocked(); err != nil {
		return PublicFood{}, true, err
	}
	for _, food := range s.foods {
		if food.ID == id {
			return publicFood(food), true, nil
		}
	}
	return PublicFood{}, false, nil
}

func (s *Store) replace(id string, data []byte) (PublicFood, bool, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return PublicFood{}, true, errors.New("bildformatet stöds inte")
	}
	hash := hashBytes(data)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hasHash(hash, id) {
		return PublicFood{}, true, duplicateError{}
	}
	for i := range s.foods {
		if s.foods[i].ID != id {
			continue
		}
		if err := writeJPEG(filepath.Join(s.mediaDir, s.foods[i].Image), img, 1800, 88); err != nil {
			return PublicFood{}, true, err
		}
		if err := writeJPEG(filepath.Join(s.mediaDir, s.foods[i].Thumbnail), img, 520, 80); err != nil {
			return PublicFood{}, true, err
		}
		s.foods[i].Hash = hash
		if err := s.persistLocked(); err != nil {
			return PublicFood{}, true, err
		}
		return publicFood(s.foods[i]), true, nil
	}
	return PublicFood{}, false, nil
}

func (s *Store) remove(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, food := range s.foods {
		if food.ID != id {
			continue
		}
		s.foods = append(s.foods[:i], s.foods[i+1:]...)
		for n := range s.foods {
			s.foods[n].Order = n
		}
		if err := s.persistLocked(); err != nil {
			return true, err
		}
		_ = os.Remove(filepath.Join(s.mediaDir, food.Image))
		_ = os.Remove(filepath.Join(s.mediaDir, food.Thumbnail))
		return true, nil
	}
	return false, nil
}

func (s *Store) persistLocked() error {
	data, err := json.MarshalIndent(s.foods, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0640); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

type duplicateError struct{}

func (duplicateError) Error() string { return "bilden finns redan i biblioteket" }

type session struct {
	Expires int64  `json:"expires"`
	CSRF    string `json:"csrf"`
}

type server struct {
	store                 *Store
	password, secret      string
	production, localMode bool
	localCSRF             string
	attemptMu             sync.Mutex
	attempts              map[string]*loginAttempt
	publicFS              fs.FS
}
type loginAttempt struct {
	Count int
	Reset time.Time
}

func newServer(dataDir, password, secret string, production bool) (*server, error) {
	if production && (len(password) < 12 || len(secret) < 32) {
		return nil, errors.New("ADMIN_PASSWORD (minst 12 tecken) och SESSION_SECRET (minst 32 tecken) krävs i produktion")
	}
	localMode := !production && password == ""
	if localMode && secret == "" {
		secret = randomToken(32)
	}
	store, err := newStore(dataDir)
	if err != nil {
		return nil, err
	}
	publicFS, err := fs.Sub(bundled, "public")
	if err != nil {
		return nil, err
	}
	return &server{store: store, password: password, secret: secret, production: production, localMode: localMode, localCSRF: randomToken(24), attempts: map[string]*loginAttempt{}, publicFS: publicFS}, nil
}

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
func (s *server) sign(value string) string {
	mac := hmac.New(sha256.New, []byte(s.secret))
	_, _ = mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (s *server) makeSession() (string, session) {
	data := session{time.Now().Add(sessionAge).UnixMilli(), randomToken(24)}
	raw, _ := json.Marshal(data)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return payload + "." + s.sign(payload), data
}
func (s *server) readSession(r *http.Request) (session, bool) {
	cookie, err := r.Cookie("vad_session")
	if err != nil {
		return session{}, false
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 || !hmac.Equal([]byte(s.sign(parts[0])), []byte(parts[1])) {
		return session{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return session{}, false
	}
	var data session
	if json.Unmarshal(raw, &data) != nil || data.Expires <= time.Now().UnixMilli() {
		return session{}, false
	}
	return data, true
}

func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if value != nil {
		_ = json.NewEncoder(w).Encode(value)
	}
}
func apiError(w http.ResponseWriter, status int, message string) {
	jsonResponse(w, status, map[string]string{"error": message})
}
func decodeJSON(r *http.Request, value any) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(value)
}

func (s *server) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func (s *server) requireAdmin(w http.ResponseWriter, r *http.Request, csrf bool) (session, bool) {
	if s.localMode && isLoopback(r) {
		if csrf && !hmac.Equal([]byte(s.localCSRF), []byte(r.Header.Get("X-CSRF-Token"))) {
			apiError(w, http.StatusForbidden, "Sessionen kunde inte verifieras. Ladda om sidan.")
			return session{}, false
		}
		return session{CSRF: s.localCSRF}, true
	}
	data, ok := s.readSession(r)
	if !ok {
		apiError(w, http.StatusUnauthorized, "Du behöver logga in som administratör.")
		return session{}, false
	}
	if csrf && !hmac.Equal([]byte(data.CSRF), []byte(r.Header.Get("X-CSRF-Token"))) {
		apiError(w, http.StatusForbidden, "Sessionen kunde inte verifieras. Ladda om sidan.")
		return session{}, false
	}
	return data, true
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/foods", s.foods)
	mux.HandleFunc("POST /api/admin/login", s.login)
	mux.HandleFunc("GET /api/admin/session", s.session)
	mux.HandleFunc("POST /api/admin/logout", s.logout)
	mux.HandleFunc("PATCH /api/admin/foods/{id}", s.updateFood)
	mux.HandleFunc("POST /api/admin/foods/{id}/move", s.moveFood)
	mux.HandleFunc("POST /api/admin/foods", s.addFood)
	mux.HandleFunc("POST /api/admin/foods/{id}/image", s.replaceFood)
	mux.HandleFunc("DELETE /api/admin/foods/{id}", s.deleteFood)
	mux.Handle("GET /media/", http.StripPrefix("/media/", http.FileServer(http.Dir(s.store.mediaDir))))
	mux.HandleFunc("GET /", s.frontend)
	return s.security(mux)
}

func (s *server) foods(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, 200, map[string]any{"foods": s.store.list(r.URL.Query().Get("available") == "true")})
}
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}
func isLoopback(r *http.Request) bool { return net.ParseIP(clientIP(r)).IsLoopback() }

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	if s.localMode && isLoopback(r) {
		jsonResponse(w, 200, map[string]any{"authenticated": true, "csrfToken": s.localCSRF})
		return
	}
	ip := clientIP(r)
	now := time.Now()
	s.attemptMu.Lock()
	attempt := s.attempts[ip]
	if attempt == nil || now.After(attempt.Reset) {
		attempt = &loginAttempt{Reset: now.Add(10 * time.Minute)}
		s.attempts[ip] = attempt
	}
	if attempt.Count >= 8 {
		s.attemptMu.Unlock()
		apiError(w, 429, "För många försök. Vänta en stund och försök igen.")
		return
	}
	s.attemptMu.Unlock()
	var body struct {
		Password string `json:"password"`
	}
	if decodeJSON(r, &body) != nil {
		apiError(w, 400, "Ogiltig begäran.")
		return
	}
	if !hmac.Equal([]byte(body.Password), []byte(s.password)) {
		s.attemptMu.Lock()
		attempt.Count++
		s.attemptMu.Unlock()
		apiError(w, 401, "Fel lösenord.")
		return
	}
	s.attemptMu.Lock()
	delete(s.attempts, ip)
	s.attemptMu.Unlock()
	cookie, data := s.makeSession()
	http.SetCookie(w, &http.Cookie{Name: "vad_session", Value: cookie, Path: "/", HttpOnly: true, Secure: s.production, SameSite: http.SameSiteStrictMode, MaxAge: int(sessionAge.Seconds())})
	jsonResponse(w, 200, map[string]any{"authenticated": true, "csrfToken": data.CSRF})
}

func (s *server) session(w http.ResponseWriter, r *http.Request) {
	if s.localMode && isLoopback(r) {
		jsonResponse(w, 200, map[string]any{"authenticated": true, "csrfToken": s.localCSRF})
		return
	}
	if data, ok := s.readSession(r); ok {
		jsonResponse(w, 200, map[string]any{"authenticated": true, "csrfToken": data.CSRF})
	} else {
		jsonResponse(w, 401, map[string]any{"authenticated": false})
	}
}
func (s *server) logout(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdmin(w, r, true); !ok {
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "vad_session", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.production, SameSite: http.SameSiteStrictMode})
	w.WriteHeader(204)
}

func (s *server) updateFood(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdmin(w, r, true); !ok {
		return
	}
	var body struct {
		Available *bool   `json:"available"`
		Name      *string `json:"name"`
	}
	if decodeJSON(r, &body) != nil {
		apiError(w, 400, "Ogiltig begäran.")
		return
	}
	food, found, err := s.store.update(r.PathValue("id"), body.Available, body.Name)
	if !found {
		apiError(w, 404, "Maten hittades inte.")
		return
	}
	if err != nil {
		apiError(w, 400, capitalize(err.Error())+".")
		return
	}
	jsonResponse(w, 200, map[string]any{"food": food})
}
func (s *server) moveFood(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdmin(w, r, true); !ok {
		return
	}
	var body struct {
		Direction string `json:"direction"`
	}
	if decodeJSON(r, &body) != nil || (body.Direction != "up" && body.Direction != "down") {
		apiError(w, 400, "Ogiltig riktning.")
		return
	}
	food, found, err := s.store.move(r.PathValue("id"), body.Direction)
	if !found {
		apiError(w, 404, "Maten hittades inte.")
		return
	}
	if err != nil {
		apiError(w, 500, "Något gick fel på servern.")
		return
	}
	jsonResponse(w, 200, map[string]any{"food": food})
}

func readUpload(w http.ResponseWriter, r *http.Request) ([]byte, string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+(1<<20))
	if err := r.ParseMultipartForm(maxUpload); err != nil {
		apiError(w, 400, "Bilden är större än 12 MB eller kunde inte läsas.")
		return nil, "", false
	}
	file, header, err := r.FormFile("image")
	if err != nil {
		apiError(w, 400, "Välj en JPG-, PNG- eller WebP-bild.")
		return nil, "", false
	}
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowedExtension(ext) {
		apiError(w, 400, "Välj en JPG-, PNG- eller WebP-bild.")
		return nil, "", false
	}
	data, err := io.ReadAll(io.LimitReader(file, maxUpload+1))
	if err != nil || len(data) > maxUpload {
		apiError(w, 400, "Bilden är större än 12 MB.")
		return nil, "", false
	}
	return data, header.Filename, true
}
func (s *server) addFood(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdmin(w, r, true); !ok {
		return
	}
	data, filename, ok := readUpload(w, r)
	if !ok {
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
		name = strings.NewReplacer("-", " ", "_", " ").Replace(name)
	}
	food, err := s.store.addImage(data, name, false)
	if err != nil {
		s.imageError(w, err)
		return
	}
	jsonResponse(w, 201, map[string]any{"food": food})
}
func (s *server) replaceFood(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdmin(w, r, true); !ok {
		return
	}
	data, _, ok := readUpload(w, r)
	if !ok {
		return
	}
	food, found, err := s.store.replace(r.PathValue("id"), data)
	if !found {
		apiError(w, 404, "Maten hittades inte.")
		return
	}
	if err != nil {
		s.imageError(w, err)
		return
	}
	jsonResponse(w, 200, map[string]any{"food": food})
}
func (s *server) imageError(w http.ResponseWriter, err error) {
	var duplicate duplicateError
	if errors.As(err, &duplicate) {
		apiError(w, 409, "Bilden finns redan i biblioteket.")
		return
	}
	if err.Error() == "bildformatet stöds inte" {
		apiError(w, 400, "Bildformatet stöds inte.")
		return
	}
	log.Printf("bildfel: %v", err)
	apiError(w, 500, "Något gick fel på servern.")
}
func (s *server) deleteFood(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdmin(w, r, true); !ok {
		return
	}
	found, err := s.store.remove(r.PathValue("id"))
	if !found {
		apiError(w, 404, "Maten hittades inte.")
		return
	}
	if err != nil {
		apiError(w, 500, "Något gick fel på servern.")
		return
	}
	w.WriteHeader(204)
}

func (s *server) frontend(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" || path == "album" || path == "admin" {
		path = "index.html"
	}
	data, err := fs.ReadFile(s.publicFS, path)
	if err != nil {
		data, _ = fs.ReadFile(s.publicFS, "index.html")
		w.WriteHeader(200)
		_, _ = w.Write(data)
		return
	}
	if kind := mime.TypeByExtension(filepath.Ext(path)); kind != "" {
		w.Header().Set("Content-Type", kind)
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(data)
}

func capitalize(value string) string {
	r := []rune(value)
	if len(r) == 0 {
		return value
	}
	if r[0] >= 'a' && r[0] <= 'z' {
		r[0] -= 32
	}
	return string(r)
}

func main() {
	noBrowser := flag.Bool("no-browser", false, "öppna inte webbläsaren automatiskt")
	showVersion := flag.Bool("version", false, "visa versionsnumret")
	flag.Parse()
	if *showVersion {
		fmt.Printf("Vad finns? %s\n", version)
		return
	}
	production := os.Getenv("NODE_ENV") == "production"
	password := os.Getenv("ADMIN_PASSWORD")
	secret := os.Getenv("SESSION_SECRET")
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	srv, err := newServer(dataDir, password, secret, production)
	if err != nil {
		log.Fatal(err)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	if password == "" && !production && host != "127.0.0.1" && host != "localhost" && host != "::1" {
		log.Fatal("ADMIN_PASSWORD krävs när programmet exponeras utanför den lokala datorn")
	}
	address := net.JoinHostPort(host, port)
	log.Printf("Vad finns? körs på http://%s", address)
	if srv.localMode {
		log.Printf("Lokal Admin är lösenordsfri och endast tillgänglig från den här datorn")
		if !*noBrowser {
			go openBrowser("http://" + address)
		}
	}
	log.Fatal(http.ListenAndServe(address, srv.routes()))
}

func openBrowser(url string) {
	time.Sleep(350 * time.Millisecond)
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		command = exec.Command("open", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	_ = command.Start()
}
