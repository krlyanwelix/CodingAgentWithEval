// execd is the in-sandbox data plane. It is a single static binary so the
// runtime image can stay small: commands run through busybox `sh`, files live
// under EXECD_ROOT, every request is authenticated with X-EXECD-ACCESS-TOKEN.
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	maxBodyBytes   = 1 << 20  // 1 MiB
	maxFileBytes   = 16 << 20 // 16 MiB
	maxOutputBytes = 512 << 10
	defaultTimeout = 120 * time.Second
	defaultPort    = 8765
	defaultRoot    = "/workspace"
	defaultHost    = "0.0.0.0"
)

var (
	root      string
	token     string
	startedAt = time.Now()
)

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type commandRequest struct {
	Command   string            `json:"command"`
	Cwd       string            `json:"cwd"`
	TimeoutMs int               `json:"timeoutMs"`
	Env       map[string]string `json:"env"`
}

type fileWriteRequest struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
	Mode     any    `json:"mode"`
}

func main() {
	token = os.Getenv("EXECD_ACCESS_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "execd: EXECD_ACCESS_TOKEN must be set")
		os.Exit(2)
	}

	rawRoot := envOr("EXECD_ROOT", defaultRoot)
	absolute, err := filepath.Abs(rawRoot)
	if err != nil {
		fatal("EXECD_ROOT is not a valid path: %v", err)
	}
	root = absolute
	if err := os.MkdirAll(root, 0o755); err != nil {
		fatal("cannot create EXECD_ROOT %s: %v", root, err)
	}

	host := envOr("EXECD_HOST", defaultHost)
	port, err := strconv.Atoi(envOr("EXECD_PORT", strconv.Itoa(defaultPort)))
	if err != nil || port < 0 || port > 65535 {
		fatal("EXECD_PORT must be a valid port number")
	}

	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		fatal("cannot listen on %s:%d: %v", host, port, err)
	}
	actual := listener.Addr().(*net.TCPAddr).Port
	fmt.Printf("execd listening on %s:%d root=%s\n", host, actual, root)

	server := &http.Server{
		Handler:           &handler{},
		ReadHeaderTimeout: 10 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		_ = server.Close()
	}()

	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal("execd server failed: %v", err)
	}
}

type handler struct{}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid X-EXECD-ACCESS-TOKEN")
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/ping":
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":       true,
			"pid":      os.Getpid(),
			"root":     root,
			"uptimeMs": time.Since(startedAt).Milliseconds(),
		})
	case r.Method == http.MethodPost && r.URL.Path == "/command":
		runCommand(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/file":
		readFile(w, r)
	case r.Method == http.MethodPut && r.URL.Path == "/file":
		writeFile(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/directory":
		listDirectory(w, r)
	default:
		writeError(w, http.StatusNotFound, "not_found", fmt.Sprintf("no route for %s %s", r.Method, r.URL.Path))
	}
}

func authorized(r *http.Request) bool {
	provided := r.Header.Get("X-EXECD-ACCESS-TOKEN")
	if provided == "" || len(provided) != len(token) {
		return false
	}
	var diff byte
	for i := 0; i < len(provided); i++ {
		diff |= provided[i] ^ token[i]
	}
	return diff == 0
}

// resolvePath maps a caller-supplied path into the sandbox root. Relative paths
// are joined with the root; the result must stay inside the root even after
// following symlinks in the existing part of the path.
func resolvePath(raw string) (string, error) {
	if raw == "" {
		raw = "."
	}
	candidate := raw
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(root, candidate)
	}
	candidate = filepath.Clean(candidate)
	resolved := evalExisting(candidate)
	if resolved != root && !strings.HasPrefix(resolved, root+string(os.PathSeparator)) {
		return "", errPathOutside
	}
	return resolved, nil
}

var errPathOutside = errors.New("path escapes the sandbox root")

func evalExisting(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	parent := filepath.Dir(path)
	if parent == path {
		return path
	}
	return filepath.Join(evalExisting(parent), filepath.Base(path))
}

func runCommand(w http.ResponseWriter, r *http.Request) {
	var request commandRequest
	if err := decodeJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if strings.TrimSpace(request.Command) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "command must not be empty")
		return
	}
	workingDir, err := resolvePath(request.Cwd)
	if err != nil {
		writeError(w, http.StatusForbidden, "path_outside_root", err.Error())
		return
	}
	info, statErr := os.Stat(workingDir)
	if statErr != nil || !info.IsDir() {
		writeError(w, http.StatusBadRequest, "invalid_request", "cwd is not a directory: "+request.Cwd)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "internal", "streaming is not supported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	timeout := defaultTimeout
	if request.TimeoutMs > 0 {
		timeout = time.Duration(request.TimeoutMs) * time.Millisecond
	}

	stream := &eventStream{w: w, flusher: flusher}

	shell, shellArgs := shellCommand(request.Command)
	cmd := exec.Command(shell, shellArgs...)
	cmd.Dir = workingDir
	cmd.Env = append(os.Environ(), envPairs(request.Env)...)
	configureCommand(cmd)
	stdout, err := cmd.StdoutPipe()
	if err == nil {
		var stderr io.ReadCloser
		stderr, err = cmd.StderrPipe()
		if err == nil {
			err = cmd.Start()
			if err == nil {
				runStream(stream, cmd, stdout, stderr, timeout)
				return
			}
		}
	}
	stream.send("stderr", map[string]string{"chunk": "execd: " + err.Error() + "\n"})
	stream.send("exit", map[string]any{"code": 127, "error": err.Error()})
}

func runStream(stream *eventStream, cmd *exec.Cmd, stdout io.ReadCloser, stderr io.ReadCloser, timeout time.Duration) {
	var timedOut atomic.Bool
	stream.onLimit = func() {
		stream.send("stderr", map[string]string{"chunk": "\nexecd: output limit reached, process killed\n"})
		killCommand(cmd)
	}
	timer := time.AfterFunc(timeout, func() {
		timedOut.Store(true)
		stream.send("stderr", map[string]string{"chunk": fmt.Sprintf("\nexecd: command timed out after %dms\n", timeout.Milliseconds())})
		killCommand(cmd)
	})
	defer timer.Stop()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); stream.pump(stdout, "stdout") }()
	go func() { defer wg.Done(); stream.pump(stderr, "stderr") }()

	waitErr := cmd.Wait()
	wg.Wait()

	code := 0
	if timedOut.Load() {
		code = 124
	} else if stream.limitHit.Load() {
		code = -1
	} else if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			code = exitErr.ExitCode()
			if code == -1 {
				code = 137 // killed by a signal
			}
		} else {
			stream.send("stderr", map[string]string{"chunk": "execd: " + waitErr.Error() + "\n"})
			code = 127
		}
	}
	stream.send("exit", map[string]any{"code": code})
}

func envPairs(env map[string]string) []string {
	pairs := make([]string, 0, len(env))
	for key, value := range env {
		pairs = append(pairs, key+"="+value)
	}
	return pairs
}

type eventStream struct {
	mu         sync.Mutex
	w          http.ResponseWriter
	flusher    http.Flusher
	total      int64
	limitHit   atomic.Bool
	onLimit    func()
	onLimitRun sync.Once
}

func (s *eventStream) pump(source io.Reader, name string) {
	buffer := make([]byte, 32*1024)
	for {
		n, err := source.Read(buffer)
		if n > 0 {
			s.send(name, map[string]string{"chunk": string(buffer[:n])})
		}
		if err != nil {
			return
		}
	}
}

func (s *eventStream) send(name string, payload any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sendUnlocked(name, payload)
}

func (s *eventStream) sendUnlocked(name string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	s.total += int64(len(data))
	if s.total > maxOutputBytes {
		if !s.limitHit.Load() {
			s.limitHit.Store(true)
			go func() {
				s.onLimitRun.Do(func() {
					if s.onLimit != nil {
						s.onLimit()
					}
				})
			}()
		}
		return
	}
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", name, data)
	s.flusher.Flush()
}

func readFile(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	target, err := resolvePath(query.Get("path"))
	if err != nil {
		writeError(w, http.StatusForbidden, "path_outside_root", err.Error())
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "not_found", "file does not exist: "+query.Get("path"))
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, "invalid_request", "path is a directory: "+query.Get("path"))
		return
	}
	if info.Size() > maxFileBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "file_too_large", fmt.Sprintf("file is %d bytes; the limit is %d", info.Size(), maxFileBytes))
		return
	}
	content, err := os.ReadFile(target)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	encoding := query.Get("encoding")
	if encoding == "base64" {
		writeJSON(w, http.StatusOK, map[string]any{
			"path":     query.Get("path"),
			"size":     len(content),
			"encoding": "base64",
			"content":  base64.StdEncoding.EncodeToString(content),
		})
		return
	}
	if !utf8.Valid(content) {
		writeError(w, http.StatusBadRequest, "not_utf8", "file is not valid UTF-8; read it with encoding=base64")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":     query.Get("path"),
		"size":     len(content),
		"encoding": "utf-8",
		"content":  string(content),
	})
}

func writeFile(w http.ResponseWriter, r *http.Request) {
	var request fileWriteRequest
	if err := decodeJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if request.Path == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "path must not be empty")
		return
	}
	target, err := resolvePath(request.Path)
	if err != nil {
		writeError(w, http.StatusForbidden, "path_outside_root", err.Error())
		return
	}
	var content []byte
	if request.Encoding == "base64" {
		decoded, err := base64.StdEncoding.DecodeString(request.Content)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "content is not valid base64")
			return
		}
		content = decoded
	} else {
		content = []byte(request.Content)
	}
	if len(content) > maxFileBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "file_too_large", fmt.Sprintf("content is %d bytes; the limit is %d", len(content), maxFileBytes))
		return
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	mode := os.FileMode(0o644)
	if parsed, ok := parseMode(request.Mode); ok {
		mode = parsed
	}
	if err := os.WriteFile(target, content, mode); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if err := os.Chmod(target, mode); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": request.Path, "bytes": len(content)})
}

func parseMode(value any) (os.FileMode, bool) {
	switch typed := value.(type) {
	case string:
		parsed, err := strconv.ParseUint(typed, 8, 32)
		if err != nil {
			return 0, false
		}
		return os.FileMode(parsed), true
	case float64:
		return os.FileMode(uint32(typed)), true
	default:
		return 0, false
	}
}

func listDirectory(w http.ResponseWriter, r *http.Request) {
	requested := r.URL.Query().Get("path")
	target, err := resolvePath(requested)
	if err != nil {
		writeError(w, http.StatusForbidden, "path_outside_root", err.Error())
		return
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "not_found", "directory does not exist: "+requested)
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	type entry struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		Size    int64  `json:"size"`
		MtimeMs int64  `json:"mtimeMs"`
	}
	result := make([]entry, 0, len(entries))
	for _, item := range entries {
		info, err := item.Info()
		if err != nil {
			continue
		}
		kind := "file"
		size := info.Size()
		if item.IsDir() {
			kind = "directory"
			size = 0
		}
		result = append(result, entry{Name: item.Name(), Type: kind, Size: size, MtimeMs: info.ModTime().UnixMilli()})
	}
	sort.SliceStable(result, func(i, j int) bool {
		if (result[i].Type == "directory") != (result[j].Type == "directory") {
			return result[i].Type == "directory"
		}
		return result[i].Name < result[j].Name
	})
	writeJSON(w, http.StatusOK, map[string]any{"path": requested, "entries": result})
}

func decodeJSON(r *http.Request, target any) error {
	body := http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("request body is not valid JSON: %v", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code string, message string) {
	var body errorBody
	body.Error.Code = code
	body.Error.Message = message
	writeJSON(w, status, body)
}

func envOr(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func fatal(format string, args ...any) {
	log.New(os.Stderr, "execd: ", 0).Printf(format, args...)
	os.Exit(1)
}
