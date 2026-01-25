package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type systemRequest struct {
	Version       int    `json:"version"`
	Type          string `json:"type"` // verify|docker.probe|cancel
	CorrelationID string `json:"correlationId"`
	Full          bool   `json:"full,omitempty"` // verify: full gates
}

type systemResponse struct {
	Version       int            `json:"version"`
	Type          string         `json:"type"` // system.result
	CorrelationID string         `json:"correlationId"`
	Ok            bool           `json:"ok"`
	Action        string         `json:"action,omitempty"`
	Summary       string         `json:"summary,omitempty"`
	Detail        string         `json:"detail,omitempty"`
	Artifacts     map[string]any `json:"artifacts,omitempty"`
	StartedAt     string         `json:"startedAt,omitempty"`
	EndedAt       string         `json:"endedAt,omitempty"`
}

func initSystemBus(responsesPath string, requestsPath string) int64 {
	for _, p := range []string{responsesPath, requestsPath} {
		if strings.TrimSpace(p) == "" {
			continue
		}
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if _, err := os.Stat(p); err != nil {
			_ = os.WriteFile(p, []byte{}, 0o644)
		}
	}
	return 0
}

func appendSystemRequest(path string, req systemRequest) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	if req.Version == 0 {
		req.Version = 1
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

func readSystemResponses(path string, offset int64) ([]systemResponse, int64) {
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

	var out []systemResponse
	reader := bufio.NewReader(f)
	cur := offset
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			cur += int64(len(line))
			txt := strings.TrimSpace(line)
			if txt != "" {
				var r systemResponse
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

func systemExecutorReadyPath(stateDir string, sessionID string) string {
	return filepath.Join(stateDir, sessionID, "system.executor.json")
}

func isSystemExecutorReady(stateDir string, sessionID string, now time.Time) bool {
	p := systemExecutorReadyPath(stateDir, sessionID)
	st, err := os.Stat(p)
	if err != nil {
		return false
	}
	if now.Sub(st.ModTime()) > 30*time.Second {
		return false
	}
	return true
}

