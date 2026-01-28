package main

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type codexTurnRequest struct {
	Version       int    `json:"version"`
	Type          string `json:"type"` // turn|cancel
	CorrelationID string `json:"correlationId"`
	Prompt        string `json:"prompt"`
	Cwd           string `json:"cwd,omitempty"`
	Model         string `json:"model,omitempty"`
	NoShell       bool   `json:"noShell,omitempty"`
	Think         bool   `json:"think,omitempty"` // request narrated reasoning/plan stream
	PermissionMode string `json:"permissionMode,omitempty"` // plan|bypass (executor-defined)
}

type codexTurnResponse struct {
	Version       int      `json:"version"`
	Type          string   `json:"type"` // turn.result
	CorrelationID string   `json:"correlationId"`
	Ok            bool     `json:"ok"`
	Content       string   `json:"content,omitempty"`
	Error         string   `json:"error,omitempty"`
	FileChanges   []string `json:"fileChanges,omitempty"`
	StartedAt     string   `json:"startedAt,omitempty"`
	EndedAt       string   `json:"endedAt,omitempty"`
}

type codexTurnEvent struct {
	Version       int    `json:"version"`
	Type          string `json:"type"` // turn.event
	CorrelationID string `json:"correlationId"`
	At            string `json:"at"`
	Kind          string `json:"kind"` // think|tool_use|step_start|step_finish|delta|info|error
	Message       string `json:"message"`
	Tool          string `json:"tool,omitempty"`
}

func initCodexBus(responsesPath string, requestsPath string, eventsPath string) (responsesOffset int64, eventsOffset int64) {
	for _, p := range []string{responsesPath, requestsPath, eventsPath} {
		if strings.TrimSpace(p) == "" {
			continue
		}
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if _, err := os.Stat(p); err != nil {
			_ = os.WriteFile(p, []byte{}, 0o644)
		}
	}
	return 0, 0
}

func appendCodexRequest(path string, req codexTurnRequest) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	if req.Version == 0 {
		req.Version = 1
	}
	if strings.TrimSpace(req.Type) == "" {
		req.Type = "turn"
	}
	b, err := json.Marshal(req)
	if err != nil {
		return err
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

func readCodexResponses(path string, offset int64) ([]codexTurnResponse, int64) {
	if strings.TrimSpace(path) == "" {
		return nil, offset
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, offset
	}
	defer f.Close()

	st, err := f.Stat()
	if err == nil && offset > st.Size() {
		offset = st.Size()
	}
	if offset > 0 {
		if _, err := f.Seek(offset, 0); err != nil {
			return nil, offset
		}
	}

	var out []codexTurnResponse
	reader := bufio.NewReader(f)
	cur := offset
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			cur += int64(len(line))
			txt := strings.TrimSpace(line)
			if txt != "" {
				var r codexTurnResponse
				if json.Unmarshal([]byte(txt), &r) == nil && r.Version == 1 && strings.TrimSpace(r.Type) != "" {
					out = append(out, r)
				}
			}
		}
		if err != nil {
			break
		}
	}
	return out, cur
}

func appendCodexEvent(path string, ev codexTurnEvent) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	if ev.Version == 0 {
		ev.Version = 1
	}
	if strings.TrimSpace(ev.Type) == "" {
		ev.Type = "turn.event"
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

func readCodexEvents(path string, offset int64) ([]codexTurnEvent, int64) {
	if strings.TrimSpace(path) == "" {
		return nil, offset
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, offset
	}
	defer f.Close()

	st, err := f.Stat()
	if err == nil && offset > st.Size() {
		offset = st.Size()
	}
	if offset > 0 {
		if _, err := f.Seek(offset, 0); err != nil {
			return nil, offset
		}
	}

	var out []codexTurnEvent
	reader := bufio.NewReader(f)
	cur := offset
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			cur += int64(len(line))
			txt := strings.TrimSpace(line)
			if txt != "" {
				var ev codexTurnEvent
				if json.Unmarshal([]byte(txt), &ev) == nil && ev.Version == 1 && strings.TrimSpace(ev.Type) == "turn.event" {
					out = append(out, ev)
				}
			}
		}
		if err != nil {
			break
		}
	}
	return out, cur
}

func codexExecutorReadyPath(stateDir string, sessionID string) string {
	return filepath.Join(stateDir, sessionID, "codex.executor.json")
}

func isCodexExecutorReady(stateDir string, sessionID string, now time.Time) bool {
	p := codexExecutorReadyPath(stateDir, sessionID)
	st, err := os.Stat(p)
	if err != nil {
		return false
	}
	// If it hasn't updated in a while, treat as not ready.
	if now.Sub(st.ModTime()) > 30*time.Second {
		return false
	}
	return true
}

// codexExecutorDiagnostic returns a human-readable reason why the executor is not ready.
// Returns empty string if everything looks fine.
func codexExecutorDiagnostic(stateDir string, sessionID string, now time.Time) string {
	// Check if codex CLI is available in PATH
	codexPath, err := exec.LookPath("codex")
	if err != nil || codexPath == "" {
		return "codex CLI not installed. Run: npm install -g @openai/codex-cli"
	}

	// Check if node is available in PATH
	nodePath, err := exec.LookPath("node")
	if err != nil || nodePath == "" {
		return "Node.js not installed. Required for Codex executor."
	}

	// Check heartbeat file
	p := codexExecutorReadyPath(stateDir, sessionID)
	st, err := os.Stat(p)
	if err != nil {
		return "Codex executor not running. Check logs: .workbench/logs/codex-executor.log"
	}

	// Check if heartbeat is stale
	if now.Sub(st.ModTime()) > 30*time.Second {
		return "Codex executor heartbeat stale. Executor may have crashed. Check: .workbench/logs/codex-executor.log"
	}

	return ""
}
