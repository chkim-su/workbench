package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type eventLogger struct {
	path string
	mu   sync.Mutex
	seq  uint64
}

type eventRecord struct {
	Timestamp     string `json:"timestamp"`
	Seq           uint64 `json:"seq"`
	Source        string `json:"source"`
	Type          string `json:"type"`
	Payload       any    `json:"payload"`
	CorrelationID string `json:"correlation_id,omitempty"`
	CausationID   string `json:"causation_id,omitempty"`
}

func newEventLogger(stateDir string, sessionID string) *eventLogger {
	if sessionID == "" {
		sessionID = "sess_unknown"
	}
	dir := filepath.Join(stateDir, sessionID)
	_ = os.MkdirAll(dir, 0o755)
	return &eventLogger{path: filepath.Join(dir, "events.jsonl")}
}

func (l *eventLogger) Append(source string, eventType string, payload any, correlationID string, causationID string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	l.seq++
	rec := eventRecord{
		Timestamp:     time.Now().UTC().Format(time.RFC3339Nano),
		Seq:           l.seq,
		Source:        source,
		Type:          eventType,
		Payload:       payload,
		CorrelationID: correlationID,
		CausationID:   causationID,
	}
	b, err := json.Marshal(rec)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(l.path), 0o755)
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	_, _ = f.Write(append(b, '\n'))
	_ = f.Close()
}

type alertSeverity string

const (
	alertInfo     alertSeverity = "INFO"
	alertWarn     alertSeverity = "WARN"
	alertError    alertSeverity = "ERROR"
	alertCritical alertSeverity = "CRITICAL"
)

type systemAlert struct {
	At            string        `json:"at"`
	Severity      alertSeverity `json:"severity"`
	Code          string        `json:"code"`
	Message       string        `json:"message"`
	Context       map[string]any `json:"context,omitempty"`
	CorrelationID string        `json:"correlation_id"`
}

func newCorrelationID() string {
	var buf [8]byte
	_, _ = rand.Read(buf[:])
	return hex.EncodeToString(buf[:])
}

