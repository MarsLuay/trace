// Package trace_runtime emits the shared @marsluay/trace event contract.
// It records control-flow and source identity only; payloads and errors stay out of records.
package trace_runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxFileBytes int64 = 1024 * 1024
const maxFiles = 8

type Config struct {
	Directory     string
	ProjectRoot   string
	Excluded      []string
	Subsystem     string
	Revision      string
	BuildID       string
	SourceIndexID string
}

type traceContext struct {
	ExecutionID  string
	InvocationID string
}

type invocation struct {
	traceContext
	ParentInvocationID *string
	ProjectPath        string
	Line               int
	Function           string
	Subsystem          string
}

type runtimeState struct {
	config   Config
	sequence uint64
	counter  uint64
	mu       sync.Mutex
}

var state atomic.Pointer[runtimeState]
var identifiers atomic.Uint64
var contextKey struct{}

func Configure(config Config) {
	if config.ProjectRoot == "" {
		config.ProjectRoot = "."
	}
	if config.Subsystem == "" {
		config.Subsystem = "go"
	}
	if len(config.Excluded) == 0 {
		config.Excluded = []string{"vendor/", "generated/", "build/", "dist/"}
	}
	state.Store(&runtimeState{config: config})
}

func Reset() { state.Store(nil) }

func RootContext() context.Context {
	current := state.Load()
	if current == nil {
		return context.Background()
	}
	return context.WithValue(context.Background(), contextKey, traceContext{ExecutionID: nextID("execution"), InvocationID: ""})
}

// Enter starts an invocation and returns a child context plus an end function.
// The end function is safe to defer and never changes application behavior.
func Enter(ctx context.Context, projectPath string, line int, function string, subsystem string) (context.Context, func()) {
	current := state.Load()
	if current == nil {
		return ctx, func() {}
	}
	if !owned(&current.config, projectPath) {
		return ctx, func() {}
	}
	parent, _ := ctx.Value(contextKey).(traceContext)
	executionID := parent.ExecutionID
	if executionID == "" {
		executionID = nextID("execution")
	}
	var parentID *string
	if parent.InvocationID != "" {
		value := parent.InvocationID
		parentID = &value
	}
	if subsystem == "" {
		subsystem = current.config.Subsystem
	}
	entry := invocation{
		traceContext:       traceContext{ExecutionID: executionID, InvocationID: nextID("invocation")},
		ParentInvocationID: parentID,
		ProjectPath:        filepath.ToSlash(projectPath),
		Line:               line,
		Function:           function,
		Subsystem:          subsystem,
	}
	writeEvent(current, entry, "enter")
	child := context.WithValue(ctx, contextKey, entry.traceContext)
	return child, func() {
		writeEvent(current, entry, "exit")
	}
}

func Inject(carrier map[string]string, ctx context.Context) map[string]string {
	result := make(map[string]string, len(carrier)+1)
	for key, value := range carrier {
		result[key] = value
	}
	value, ok := ctx.Value(contextKey).(traceContext)
	if !ok || value.ExecutionID == "" || value.InvocationID == "" {
		return result
	}
	payload, _ := json.Marshal(map[string]string{"executionId": value.ExecutionID, "invocationId": value.InvocationID})
	result["x-trace-correlation"] = base64.RawURLEncoding.EncodeToString(payload)
	return result
}

func Extract(carrier map[string]string) context.Context {
	value, ok := carrier["x-trace-correlation"]
	if !ok {
		return context.Background()
	}
	payload, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return context.Background()
	}
	var decoded struct{ ExecutionID, InvocationID string }
	if json.Unmarshal(payload, &decoded) != nil || decoded.ExecutionID == "" || decoded.InvocationID == "" {
		return context.Background()
	}
	return context.WithValue(context.Background(), contextKey, traceContext{ExecutionID: decoded.ExecutionID, InvocationID: decoded.InvocationID})
}

func nextID(kind string) string {
	return fmt.Sprintf("go-%s-%d", kind, identifiers.Add(1))
}

func owned(config *Config, projectPath string) bool {
	clean := filepath.ToSlash(filepath.Clean(projectPath))
	if filepath.IsAbs(projectPath) {
		root, rootErr := filepath.Abs(config.ProjectRoot)
		path, pathErr := filepath.Abs(projectPath)
		if rootErr != nil || pathErr != nil {
			return false
		}
		relative, err := filepath.Rel(root, path)
		if err != nil || strings.HasPrefix(relative, "..") {
			return false
		}
		clean = filepath.ToSlash(relative)
	}
	if !strings.HasSuffix(clean, ".go") || strings.HasPrefix(clean, "../") {
		return false
	}
	for _, pattern := range config.Excluded {
		pattern = strings.TrimPrefix(filepath.ToSlash(pattern), "./")
		if strings.HasPrefix(clean, pattern) || strings.Contains(clean, "/"+pattern) {
			return false
		}
	}
	return true
}

func writeEvent(current *runtimeState, entry invocation, kind string) {
	current.mu.Lock()
	defer current.mu.Unlock()
	current.sequence++
	record := map[string]any{
		"schemaVersion":      1,
		"eventId":            nextID("event"),
		"executionId":        entry.ExecutionID,
		"invocationId":       entry.InvocationID,
		"parentInvocationId": entry.ParentInvocationID,
		"sequence":           fmt.Sprintf("%d", current.sequence),
		"emittedAt":          time.Now().UTC().Format(time.RFC3339Nano),
		"event":              kind,
		"function":           entry.Function,
		"subsystem":          entry.Subsystem,
		"language":           "go",
		"runtime":            "go",
		"source": map[string]any{
			"projectPath":   entry.ProjectPath,
			"line":          entry.Line,
			"column":        1,
			"revision":      nullable(current.config.Revision),
			"buildId":       nullable(current.config.BuildID),
			"sourceIndexId": nullable(current.config.SourceIndexID),
		},
	}
	line, err := json.Marshal(record)
	if err != nil || int64(len(line)+1) > maxFileBytes || os.MkdirAll(current.config.Directory, 0o755) != nil {
		return
	}
	files := traceFiles(current.config.Directory)
	path := ""
	if len(files) > 0 {
		candidate := files[len(files)-1]
		if info, statErr := os.Stat(candidate); statErr == nil && info.Size()+int64(len(line)+1) <= maxFileBytes {
			path = candidate
		}
	}
	if path == "" {
		path = filepath.Join(current.config.Directory, fmt.Sprintf("trace-%012d.jsonl", len(files)))
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	_, _ = file.Write(append(line, '\n'))
	_ = file.Close()
	files = append(files, path)
	for len(files) > maxFiles {
		_ = os.Remove(files[0])
		files = files[1:]
	}
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func traceFiles(directory string) []string {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "trace-") && strings.HasSuffix(entry.Name(), ".jsonl") {
			files = append(files, filepath.Join(directory, entry.Name()))
		}
	}
	sort.Strings(files)
	return files
}
