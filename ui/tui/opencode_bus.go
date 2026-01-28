package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type opencodeTurnRequest struct {
	Version       int    `json:"version"`
	Type          string `json:"type"` // turn|cancel
	CorrelationID string `json:"correlationId"`
	Prompt        string `json:"prompt"`
	Cwd           string `json:"cwd,omitempty"`
	Model         string `json:"model,omitempty"` // provider/model (OpenCode format)
	Agent         string `json:"agent,omitempty"`
	Think         bool   `json:"think,omitempty"` // request narrated reasoning/plan stream
	PermissionMode string `json:"permissionMode,omitempty"` // plan|bypass (executor-defined)
}

type opencodeTurnResponse struct {
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

type opencodeTurnEvent struct {
	Version       int    `json:"version"`
	Type          string `json:"type"` // turn.event
	CorrelationID string `json:"correlationId"`
	At            string `json:"at"`
	Kind          string `json:"kind"` // think|tool_use|step_start|step_finish|info|error
	Message       string `json:"message"`
	Tool          string `json:"tool,omitempty"`
}

func initOpencodeBus(responsesPath string, requestsPath string, eventsPath string) (responsesOffset int64, eventsOffset int64) {
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

func appendOpencodeRequest(path string, req opencodeTurnRequest) error {
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

func readOpencodeResponses(path string, offset int64) ([]opencodeTurnResponse, int64) {
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

	var out []opencodeTurnResponse
	reader := bufio.NewReader(f)
	cur := offset
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			cur += int64(len(line))
			txt := strings.TrimSpace(line)
			if txt != "" {
				var r opencodeTurnResponse
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

func readOpencodeEvents(path string, offset int64) ([]opencodeTurnEvent, int64) {
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

	var out []opencodeTurnEvent
	reader := bufio.NewReader(f)
	cur := offset
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			cur += int64(len(line))
			txt := strings.TrimSpace(line)
			if txt != "" {
				var ev opencodeTurnEvent
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

func opencodeExecutorReadyPath(stateDir string, sessionID string) string {
	return filepath.Join(stateDir, sessionID, "opencode.executor.json")
}

func isOpencodeExecutorReady(stateDir string, sessionID string, now time.Time) bool {
	p := opencodeExecutorReadyPath(stateDir, sessionID)
	st, err := os.Stat(p)
	if err != nil {
		return false
	}
	if now.Sub(st.ModTime()) > 30*time.Second {
		return false
	}
	return true
}
