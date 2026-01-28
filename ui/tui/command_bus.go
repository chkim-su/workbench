package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

type busCommand struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	Text    string `json:"text,omitempty"`
	Keys    string `json:"keys,omitempty"`
	Mode    string `json:"mode,omitempty"`   // A|B
	Runtime string `json:"runtime,omitempty"` // codex-chat|codex-cli|opencode-run|...
	Model   string `json:"model,omitempty"`  // model selection string (e.g., gpt-5.2)
	PermissionMode string `json:"permissionMode,omitempty"` // plan|bypass
	// ThoughtStream is optional to preserve backward compatibility; if omitted it won't change.
	ThoughtStream *bool `json:"thoughtStream,omitempty"`
	Source  string `json:"source,omitempty"` // cli|tui|system
}

func initCommandBus(path string) int64 {
	if strings.TrimSpace(path) == "" {
		return 0
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	if _, err := os.Stat(path); err != nil {
		_ = os.WriteFile(path, []byte{}, 0o644)
		return 0
	}
	return 0
}

func (m appModel) consumeCommandBus() (appModel, tea.Cmd) {
	if strings.TrimSpace(m.commandBusPath) == "" {
		return m, nil
	}
	cmds, newOffset := readBusCommands(m.commandBusPath, m.commandBusOffset)
	m.commandBusOffset = newOffset
	var outCmds []tea.Cmd
	for _, c := range cmds {
		var cmd tea.Cmd
		m, cmd = m.applyBusCommand(c)
		if cmd != nil {
			outCmds = append(outCmds, cmd)
		}
		if m.quitRequested {
			break
		}
	}
	if len(outCmds) == 0 {
		return m, nil
	}
	return m, tea.Batch(outCmds...)
}

func readBusCommands(path string, offset int64) ([]busCommand, int64) {
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

	var cmds []busCommand
	reader := bufio.NewReader(f)
	cur := offset
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			cur += int64(len(line))
			txt := strings.TrimSpace(line)
			if txt != "" {
				var c busCommand
				if json.Unmarshal([]byte(txt), &c) == nil && c.Version == 1 && strings.TrimSpace(c.Type) != "" {
					cmds = append(cmds, c)
				}
			}
		}
		if err != nil {
			break
		}
	}
	return cmds, cur
}

func (m appModel) applyBusCommand(c busCommand) (appModel, tea.Cmd) {
	src := strings.TrimSpace(c.Source)
	if src == "" {
		src = "cli"
	}
	prevSource := m.actionSource
	m.actionSource = src
	defer func() { m.actionSource = prevSource }()

	switch strings.TrimSpace(strings.ToLower(c.Type)) {
	case "stop":
		m.systemAlert(alertInfo, "session.stop", "Stop requested", map[string]any{"source": src})
		m = m.closeAllOverlays()
		m.quitRequested = true
		return m, tea.Quit
	case "set":
		changed := false
		if s := strings.ToUpper(strings.TrimSpace(c.Mode)); s != "" {
			if s == "A" {
				m.mode = modeA
				changed = true
				m.systemAlert(alertInfo, "dev.set.mode", "Mode set to A", map[string]any{"source": src})
			} else if s == "B" {
				m.mode = modeB
				changed = true
				m.systemAlert(alertInfo, "dev.set.mode", "Mode set to B", map[string]any{"source": src})
			} else {
				m.systemAlert(alertWarn, "dev.set.mode.invalid", "Invalid mode (expected A or B)", map[string]any{"mode": c.Mode, "source": src})
			}
		}
		if r := strings.TrimSpace(c.Runtime); r != "" {
			found := false
			for _, opt := range runtimeOptionsUnified() {
				if opt.ID == r {
					found = true
					break
				}
			}
			if found {
				m.selectedRuntime = r
				changed = true
				compat := getCompatibilityLabel(m.selectedProvider, m.selectedRuntime)
				m.systemAlert(alertInfo, "dev.set.runtime", fmt.Sprintf("Runtime set to %s (%s)", m.selectedRuntimeLabel(), compat), map[string]any{"runtime": r, "compatibility": compat, "source": src})
			} else {
				m.systemAlert(alertWarn, "dev.set.runtime.invalid", "Unknown runtime id", map[string]any{"runtime": r, "source": src})
			}
		}
		if s := strings.TrimSpace(c.Model); s != "" {
			m.selectedModel = s
			changed = true
			m.systemAlert(alertInfo, "dev.set.model", "Model set to "+s, map[string]any{"model": s, "source": src})
		}
		if pm := strings.ToLower(strings.TrimSpace(c.PermissionMode)); pm != "" {
			if pm == "plan" || pm == "bypass" {
				m.permissionMode = pm
				changed = true
				m.systemAlert(alertInfo, "dev.set.permission_mode", "Permission mode set to "+m.permissionModeLabel(), map[string]any{"permissionMode": pm, "source": src})
			} else {
				m.systemAlert(alertWarn, "dev.set.permission_mode.invalid", "Invalid permissionMode (expected plan or bypass)", map[string]any{"permissionMode": c.PermissionMode, "source": src})
			}
		}
		if c.ThoughtStream != nil {
			m.thoughtStream = *c.ThoughtStream
			changed = true
			m.systemAlert(alertInfo, "dev.set.thought_stream", "Thought stream updated", map[string]any{"enabled": m.thoughtStream, "source": src})
		}
		if !changed {
			m.systemAlert(alertWarn, "dev.set.noop", "Set command contained no changes", map[string]any{"source": src})
		}
		return m, nil
	case "send":
		txt := strings.TrimSpace(c.Text)
		if txt == "" {
			return m, nil
		}
		var cmd tea.Cmd
		m, cmd = m.sendChat(txt)
		return m, cmd
	case "cmd":
		return m.executeCommandText(strings.TrimSpace(c.Text))
	case "key":
		keys := splitKeys(c.Keys)
		var cmds []tea.Cmd
		for _, k := range keys {
			if m.quitRequested {
				break
			}
			var cmd tea.Cmd
			m, cmd = m.applySyntheticKey(k)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		}
		if len(cmds) == 0 {
			return m, nil
		}
		return m, tea.Batch(cmds...)
	default:
		m.systemAlert(alertWarn, "command.unknown", "Unknown bus command type", map[string]any{"type": c.Type})
		return m, nil
	}
}

func splitKeys(keys string) []string {
	raw := strings.FieldsFunc(keys, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t'
	})
	out := make([]string, 0, len(raw))
	for _, t := range raw {
		s := strings.TrimSpace(t)
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (m appModel) applySyntheticKey(token string) (appModel, tea.Cmd) {
	t := strings.TrimSpace(token)
	if t == "" {
		return m, nil
	}
	lt := strings.ToLower(t)

	var msg tea.KeyMsg
	switch lt {
	case "enter":
		msg = tea.KeyMsg{Type: tea.KeyEnter}
	case "esc", "escape":
		msg = tea.KeyMsg{Type: tea.KeyEscape}
	case "up":
		msg = tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		msg = tea.KeyMsg{Type: tea.KeyDown}
	case "tab":
		msg = tea.KeyMsg{Type: tea.KeyTab}
	case "shift+tab", "shift-tab", "shifttab":
		msg = tea.KeyMsg{Type: tea.KeyShiftTab}
	case "backspace":
		msg = tea.KeyMsg{Type: tea.KeyBackspace}
	default:
		// Single rune fallthrough.
		rs := []rune(t)
		msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: rs}
	}

	next, cmd := m.Update(msg)
	if am, ok := next.(appModel); ok {
		m = am
	}
	return m, cmd
}

func (m appModel) executeCommandText(text string) (appModel, tea.Cmd) {
	txt := strings.TrimSpace(text)
	if txt == "" {
		return m, nil
	}
	ns := "/"
	cmdText := txt
	if strings.HasPrefix(cmdText, "//") {
		ns = "//"
		cmdText = strings.TrimPrefix(cmdText, "//")
	} else if strings.HasPrefix(cmdText, "/") {
		ns = "/"
		cmdText = strings.TrimPrefix(cmdText, "/")
	} else {
		m.systemAlert(alertWarn, "command.invalid", "Command must start with / or //", map[string]any{"text": txt})
		return m, nil
	}

	cmdName := strings.Fields(strings.TrimSpace(cmdText))
	if len(cmdName) == 0 {
		m.systemAlert(alertWarn, "command.invalid", "Empty command", map[string]any{"text": txt})
		return m, nil
	}

	// System commands can take arguments (e.g. //verify full, //docker probe).
	// For all other // commands, fall through to the system command palette registry.
	if ns == "//" {
		name := cmdName[0]
		args := cmdName[1:]
		switch name {
		case "verify":
			full := false
			if len(args) > 0 {
				a := strings.ToLower(strings.TrimSpace(args[0]))
				full = a == "full" || a == "--full"
			}
			next, cmd := m.submitSystemVerify(full, "")
			if am, ok := next.(appModel); ok {
				m = am
			}
			return m, cmd
		case "docker":
			// Default subcommand is probe/status-equivalent.
			sub := "probe"
			if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
				sub = strings.ToLower(strings.TrimSpace(args[0]))
			}
			if sub == "probe" || sub == "status" {
				next, cmd := m.submitSystemDockerProbe("")
				if am, ok := next.(appModel); ok {
					m = am
				}
				return m, cmd
			}
			m.systemAlert(alertError, "command.invalid", "Unknown //docker subcommand", map[string]any{"subcommand": sub})
			return m, nil
		}
	}

	m.commandPaletteNamespace = ns
	item, ok := findPaletteItem(ns, cmdName[0])
	if !ok {
		m.systemAlert(alertError, "command.not_found", "Command not found", map[string]any{"namespace": ns, "cmd": cmdName[0]})
		return m, nil
	}

	next, cmd := m.applyCommandPalette(item)
	if am, ok := next.(appModel); ok {
		m = am
	}
	return m, cmd
}

func findPaletteItem(namespace string, cmd string) (paletteItem, bool) {
	name := strings.TrimSpace(cmd)
	if name == "" {
		return paletteItem{}, false
	}
	items := commandPaletteItems()
	if namespace == "//" {
		items = systemCommandPaletteItems()
	}
	for _, it := range items {
		if it.cmd == name {
			return it, true
		}
	}
	return paletteItem{}, false
}
