package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

func writeSessionSummary(m appModel) {
	if m.cfg.stateDir == "" || m.sessionID == "" {
		return
	}
	dir := filepath.Join(m.cfg.stateDir, m.sessionID)
	_ = os.MkdirAll(dir, 0o755)

	alerts := m.alerts
	if len(alerts) > 10 {
		alerts = alerts[len(alerts)-10:]
	}
	cmds := m.recentCommands
	if len(cmds) > 10 {
		cmds = cmds[len(cmds)-10:]
	}

	out := map[string]any{
		"version":           1,
		"updatedAt":         time.Now().UTC().Format(time.RFC3339Nano),
		"sessionId":         m.sessionID,
		"mode":              m.mode.String(),
		"screen":            m.currentScreen().String(),
		"overlay":           m.currentOverlay().String(),
		"selectedProvider":  m.selectedProvider,
		"selectedRuntime":   m.selectedRuntime,
		"selectedModel":     m.selectedModel,
		"permissionMode":    m.permissionMode,
		"thoughtStream":     m.thoughtStream,
		"compatibility":     m.currentCompatibility().String(),
		"activeOAuthEmail":  m.lastOAuthProfile,
		"recentAlerts":      alerts,
		"recentCommands":    cmds,
		"eventsPath":        filepath.Join(dir, "events.jsonl"),
	}

	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "summary.json"), append(b, '\n'), 0o644)
}
