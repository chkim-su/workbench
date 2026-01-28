package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	var smoke bool
	var serve bool
	var sessionOverride string
	flag.BoolVar(&smoke, "smoke", false, "run deterministic non-interactive smoke simulation")
	flag.BoolVar(&serve, "serve", false, "run headless command-bus driven session (for CLI/devops control)")
	flag.StringVar(&sessionOverride, "session-id", "", "override session id (for dev sessions)")
	flag.Parse()

	stateDir := os.Getenv("WORKBENCH_STATE_DIR")
	if strings.TrimSpace(stateDir) == "" {
		stateDir = ".workbench"
	}

	disableNetwork := envBool("WORKBENCH_TUI_DISABLE_NETWORK") || ((smoke || serve) && !envBool("WORKBENCH_TUI_ENABLE_NETWORK"))

	sessionID := strings.TrimSpace(sessionOverride)
	if sessionID == "" {
		// Default behavior: start a new session unless explicitly asked to resume.
		// This avoids "stuck busy" and confusing persistence when reopening Workbench in tmux.
		if envBool("WORKBENCH_RESUME") || envBool("WORKBENCH_RESUME_SESSION") {
			sid, _ := getOrCreateSessionID(stateDir)
			sessionID = sid
		} else {
			sid, _ := createNewSessionID(stateDir)
			_ = setCurrentSessionID(stateDir, sid)
			sessionID = sid
		}
	}
	mcpConnected := readMcpConnectedCount(stateDir)

	m := newAppModel(appConfig{
		stateDir:      stateDir,
		sessionID:     sessionID,
		mcpConnected:  mcpConnected,
		targetSystem:  "WSL2 (Ubuntu)",
		applicationV:  "v1.0.0",
		verifiedFiles: 0,
		commandsPath:  filepath.Join(stateDir, sessionID, "commands.jsonl"),
		disableNetwork: disableNetwork,
		codexRequestsPath:  filepath.Join(stateDir, sessionID, "codex.requests.jsonl"),
		codexResponsesPath: filepath.Join(stateDir, sessionID, "codex.responses.jsonl"),
		codexEventsPath:    filepath.Join(stateDir, sessionID, "codex.events.jsonl"),
		systemRequestsPath:  filepath.Join(stateDir, sessionID, "system.requests.jsonl"),
		systemResponsesPath: filepath.Join(stateDir, sessionID, "system.responses.jsonl"),
		opencodeRequestsPath:  filepath.Join(stateDir, sessionID, "opencode.requests.jsonl"),
		opencodeResponsesPath: filepath.Join(stateDir, sessionID, "opencode.responses.jsonl"),
		opencodeEventsPath:    filepath.Join(stateDir, sessionID, "opencode.events.jsonl"),
	})

	if smoke {
		outDir := os.Getenv("WORKBENCH_TUI_SMOKE_OUT_DIR")
		if strings.TrimSpace(outDir) == "" {
			outDir = filepath.Join(stateDir, "verify", "tui", fmt.Sprintf("run_%d", time.Now().UnixMilli()))
		}
		_ = os.MkdirAll(outDir, 0o755)
		report := runSmoke(m)
		_ = os.WriteFile(filepath.Join(outDir, "view.txt"), []byte(report.view+"\n"), 0o644)
		_ = os.WriteFile(filepath.Join(outDir, "summary.json"), []byte(report.json+"\n"), 0o644)
		writeSessionSummary(report.final)
		fmt.Println("tui-smoke-ok")
		return
	}

	if serve {
		p := tea.NewProgram(
			m,
			tea.WithoutRenderer(),
			tea.WithInput(bytes.NewReader(nil)),
			tea.WithOutput(io.Discard),
		)
		finalModel, err := p.Run()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if am, ok := finalModel.(appModel); ok {
			writeSessionSummary(am)
		}
		return
	}

	p := tea.NewProgram(m, tea.WithAltScreen())
	finalModel, err := p.Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if am, ok := finalModel.(appModel); ok {
		writeSessionSummary(am)
	}
}

func envBool(name string) bool {
	v := strings.TrimSpace(os.Getenv(name))
	return v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes") || strings.EqualFold(v, "on")
}

type smokeReport struct {
	view string
	json string
	final appModel
}

func runSmoke(m appModel) smokeReport {
	var model tea.Model = m

	// Launcher -> Mode B -> Provider config -> Cockpit
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyDown})
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	commandPaletteOpened := false
	quickActionsOpened := false
	modelSelectOpened := false
	modelChanged := false
	selectedModel := ""
	systemPaletteOpened := false
	quitConfirmOpened := false
	escClosedPalette := false
	backToLauncher := false
	systemPaletteHasDocker := false

	// Open session command palette deterministically: "/c" (slash pending + other rune => session namespace).
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("c")})
	if am, ok := model.(appModel); ok {
		commandPaletteOpened = am.currentOverlay() == overlayCommandPalette && am.commandPaletteNamespace == "/"
	}

	// Esc closes palette and keeps cockpit.
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if am, ok := model.(appModel); ok {
		escClosedPalette = am.currentOverlay() == overlayNone && am.currentScreen() == screenCockpit
	}

	// Open system command palette deterministically: "//".
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	if am, ok := model.(appModel); ok {
		systemPaletteOpened = am.currentOverlay() == overlayCommandPalette && am.commandPaletteNamespace == "//"
	}
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("d")})
	if am, ok := model.(appModel); ok {
		items := filteredCommandPaletteItems(am.commandPaletteNamespace, am.commandPaletteQuery)
		systemPaletteHasDocker = len(items) > 0 && items[0].cmd == "docker"
	}
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEscape})

	// Select "//model"
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("m")})
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if am, ok := model.(appModel); ok {
		modelSelectOpened = am.currentOverlay() == overlayModelSelect
	}

	// Pick a non-default model and apply
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyDown})
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if am, ok := model.(appModel); ok {
		selectedModel = am.selectedModel
		modelChanged = selectedModel != "" && selectedModel != "gpt-5.2"
	}

	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if am, ok := model.(appModel); ok {
		quickActionsOpened = am.currentOverlay() == overlayQuickActions
	}
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEscape})

	// Esc back-navigation: cockpit -> provider_config -> launcher, then launcher Esc opens quit confirm.
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEscape})
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if am, ok := model.(appModel); ok {
		backToLauncher = am.currentScreen() == screenLauncher
	}
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if am, ok := model.(appModel); ok {
		quitConfirmOpened = am.currentOverlay() == overlayQuitConfirm
	}
	model, _ = model.Update(tea.KeyMsg{Type: tea.KeyEscape})

	am, _ := model.(appModel)
	view := am.View()
	summary := map[string]any{
		"version":       1,
		"ok":            true,
		"sessionId":     am.sessionID,
		"mcpConnected":  am.mcpConnected,
		"screen":        am.currentScreen().String(),
		"overlay":       am.currentOverlay().String(),
		"quickActions":  am.quickActionsVisible,
		"commandPaletteOpened": commandPaletteOpened,
		"systemPaletteOpened":  systemPaletteOpened,
		"systemPaletteHasDocker": systemPaletteHasDocker,
		"escClosedPalette":     escClosedPalette,
		"backToLauncher":       backToLauncher,
		"quitConfirmOpened":    quitConfirmOpened,
		"quickActionsOpened":   quickActionsOpened,
		"modelSelectOpened":    modelSelectOpened,
		"modelChanged":         modelChanged,
		"selectedModel":        selectedModel,
	}
	b, _ := json.Marshal(summary)

	return smokeReport{view: view, json: string(b), final: am}
}

func readMcpConnectedCount(stateDir string) int {
	reg := filepath.Join(stateDir, "registry", "mcp.json")
	raw, err := os.ReadFile(reg)
	if err != nil {
		return 0
	}
	var parsed struct {
		Servers map[string]struct {
			LastHandshakeOk bool `json:"lastHandshakeOk"`
		} `json:"servers"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return 0
	}
	n := 0
	for _, s := range parsed.Servers {
		if s.LastHandshakeOk {
			n++
		}
	}
	return n
}

func getOrCreateSessionID(stateDir string) (string, error) {
	currentPath := filepath.Join(stateDir, "state", "current.json")
	_ = os.MkdirAll(filepath.Dir(currentPath), 0o755)

	var current map[string]any
	if raw, err := os.ReadFile(currentPath); err == nil {
		_ = json.Unmarshal(raw, &current)
	}
	if current == nil {
		current = map[string]any{"schemaVersion": 1}
	}

	if v, ok := current["sessionId"].(string); ok && strings.TrimSpace(v) != "" {
		return v, nil
	}

	buf := make([]byte, 4)
	_, _ = rand.Read(buf)
	id := "sess_" + hex.EncodeToString(buf)

	current["sessionId"] = id
	current["updatedAt"] = time.Now().UTC().Format(time.RFC3339)
	b, _ := json.MarshalIndent(current, "", "  ")
	if err := os.WriteFile(currentPath, append(b, '\n'), 0o644); err != nil {
		return id, err
	}
	return id, nil
}

func createNewSessionID(stateDir string) (string, error) {
	buf := make([]byte, 4)
	_, _ = rand.Read(buf)
	id := "sess_" + hex.EncodeToString(buf)
	// Ensure directory exists eagerly.
	_ = os.MkdirAll(filepath.Join(stateDir, id), 0o755)
	return id, nil
}

func setCurrentSessionID(stateDir string, sessionID string) error {
	currentPath := filepath.Join(stateDir, "state", "current.json")
	_ = os.MkdirAll(filepath.Dir(currentPath), 0o755)

	var current map[string]any
	if raw, err := os.ReadFile(currentPath); err == nil {
		_ = json.Unmarshal(raw, &current)
	}
	if current == nil {
		current = map[string]any{"schemaVersion": 1}
	}
	current["sessionId"] = sessionID
	current["updatedAt"] = time.Now().UTC().Format(time.RFC3339)
	b, _ := json.MarshalIndent(current, "", "  ")
	return os.WriteFile(currentPath, append(b, '\n'), 0o644)
}
