package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type screen int

const (
	screenLauncher screen = iota
	screenProviderConfig
	screenCockpit
)

func (s screen) String() string {
	switch s {
	case screenLauncher:
		return "launcher"
	case screenProviderConfig:
		return "provider_config"
	case screenCockpit:
		return "cockpit"
	default:
		return "unknown"
	}
}

type mode int

const (
	modeA mode = iota
	modeB
)

func (m mode) String() string {
	switch m {
	case modeA:
		return "A"
	case modeB:
		return "B"
	default:
		return "?"
	}
}

type overlay int

const (
	overlayNone overlay = iota
	overlayCommandPalette
	overlayQuickActions
	overlayModelSelect
	overlayQuitConfirm
	overlayAuthSelect
	overlayStats
	overlaySystemInfo
	overlayProviderSelect
	overlayRuntimeSelect
)

func (o overlay) String() string {
	switch o {
	case overlayNone:
		return "none"
	case overlayCommandPalette:
		return "command_palette"
	case overlayQuickActions:
		return "quick_actions"
	case overlayModelSelect:
		return "model_select"
	case overlayQuitConfirm:
		return "quit_confirm"
	case overlayAuthSelect:
		return "auth_select"
	case overlayStats:
		return "stats"
	case overlaySystemInfo:
		return "system_info"
	case overlayProviderSelect:
		return "provider_select"
	case overlayRuntimeSelect:
		return "runtime_select"
	default:
		return "unknown"
	}
}

type appConfig struct {
	stateDir      string
	sessionID     string
	mcpConnected  int
	targetSystem  string
	applicationV  string
	verifiedFiles int
	commandsPath  string
	disableNetwork bool
	codexRequestsPath  string
	codexResponsesPath string
	codexEventsPath    string
	systemRequestsPath  string
	systemResponsesPath string
	opencodeRequestsPath  string
	opencodeResponsesPath string
	opencodeEventsPath    string
}

type appModel struct {
	cfg appConfig
	th  theme

	width  int
	height int

	sessionID    string
	mcpConnected int

	screens []screen
	mode    mode

	launcherSelected int

	providerSelected int
	providerSelectedA int
	providerSelectedB int
	providerFocus    int

	overlays            []overlay
	commandPaletteIndex int
	commandPaletteQuery string
	quickActionsIndex   int
	quickActionsVisible bool

	selectedModel   string
	modelSelectIndex int

	// Provider (LLM vendor) - e.g., "OpenAI", "Anthropic", "Google (Gemini)", "Ollama (local)"
	selectedProvider string
	providerSelectIndex int

	// Runtime (unified) - e.g., "codex-chat", "codex-cli", "claude-code", "direct-api"
	selectedRuntime string
	runtimeSelectIndex int

	authSelectIndex int

	input string

	chatLines []string
	chatRoleLines []chatRoleLine
	chatMessages []chatMessage
	chatInFlight bool
	chatCancel context.CancelFunc
	chatCorrelationID string
	chatActiveProfile string
	alerts    []systemAlert

	recentCommands []string

	lastOAuthProfile string
	oauthFlashUntil time.Time
	oauthPool       oauthPoolSnapshot

	usageByProfile          map[string]*usageData
	usageFetchInFlight      map[string]bool
	usageLastCacheNotified  map[string]int64
	usageLastErrorNotified  map[string]time.Time

	events *eventLogger

	now                 time.Time
	slashPending        bool
	slashPendingUntil   time.Time
	commandPaletteNamespace string // "/" or "//"

	commandBusPath   string
	commandBusOffset int64
	actionSource     string // tui|cli
	quitRequested    bool

	codexRequestsPath  string
	codexResponsesPath string
	codexEventsPath    string
	codexResponsesOffset int64
	codexEventsOffset    int64
	codexExecutorReady bool

	opencodeRequestsPath     string
	opencodeResponsesPath    string
	opencodeEventsPath       string
	opencodeResponsesOffset  int64
	opencodeEventsOffset     int64
	opencodeExecutorReady    bool

	thoughtStream bool
	chatStreamText string

	systemRequestsPath  string
	systemResponsesPath string
	systemResponsesOffset int64
	systemExecutorReady bool
	systemInFlight bool
	systemCorrelationID string
	systemLastResult *systemResponse
}

func newAppModel(cfg appConfig) appModel {
	m := appModel{
		cfg:          cfg,
		th:           defaultTheme(),
		sessionID:    cfg.sessionID,
		mcpConnected: cfg.mcpConnected,
		screens:      []screen{screenLauncher},
		mode:         modeB,
		selectedModel: "gpt-5.2",
		selectedProvider: "OpenAI",
		selectedRuntime: "codex-cli",
		chatLines:    []string{},
		chatRoleLines: []chatRoleLine{},
		chatMessages: []chatMessage{},
		alerts:       []systemAlert{},
		recentCommands: []string{},
		events:       newEventLogger(cfg.stateDir, cfg.sessionID),
		commandPaletteNamespace: "/",
		commandBusPath: cfg.commandsPath,
		actionSource:   "tui",
		usageByProfile:     map[string]*usageData{},
		usageFetchInFlight: map[string]bool{},
		usageLastCacheNotified: map[string]int64{},
		usageLastErrorNotified: map[string]time.Time{},

		codexRequestsPath:  cfg.codexRequestsPath,
		codexResponsesPath: cfg.codexResponsesPath,
		codexEventsPath:    cfg.codexEventsPath,

		systemRequestsPath:  cfg.systemRequestsPath,
		systemResponsesPath: cfg.systemResponsesPath,

		opencodeRequestsPath:  cfg.opencodeRequestsPath,
		opencodeResponsesPath: cfg.opencodeResponsesPath,
		opencodeEventsPath:    cfg.opencodeEventsPath,

		thoughtStream: thoughtStreamEnabled(),
	}
	m.commandBusOffset = initCommandBus(cfg.commandsPath)
	m.codexResponsesOffset, m.codexEventsOffset = initCodexBus(cfg.codexResponsesPath, cfg.codexRequestsPath, cfg.codexEventsPath)
	m.opencodeResponsesOffset, m.opencodeEventsOffset = initOpencodeBus(cfg.opencodeResponsesPath, cfg.opencodeRequestsPath, cfg.opencodeEventsPath)
	m.systemResponsesOffset = initSystemBus(cfg.systemResponsesPath, cfg.systemRequestsPath)
	m.systemAlert(alertInfo, "workbench.started", "Workbench shell started", nil)
	return m
}

func (m appModel) Init() tea.Cmd {
	return tickCmd()
}

func (m appModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch t := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = t.Width
		m.height = t.Height
		return m, nil
	case chatReplyMsg:
		if m.chatCorrelationID != "" && t.CorrelationID != "" && t.CorrelationID != m.chatCorrelationID {
			return m, nil
		}
		m.chatInFlight = false
		m.chatCorrelationID = ""
		m.chatActiveProfile = ""
		m.chatStreamText = ""
		if m.chatCancel != nil {
			m.chatCancel()
			m.chatCancel = nil
		}
		if t.Cancelled {
			m.systemAlert(alertInfo, "chat.cancelled", "Chat request cancelled", nil)
			return m, nil
		}
		if strings.TrimSpace(t.Text) != "" {
			m.chatRoleLines = append(m.chatRoleLines, chatRoleLine{Role: "assistant", Text: strings.TrimRight(t.Text, "\n")})
			m.chatMessages = append(m.chatMessages, chatMessage{Role: "assistant", Content: t.Text})
			m.emitEvent("llm.response", "system", map[string]any{"provider": t.Provider, "profile": t.Profile, "status": t.Status}, t.CorrelationID, "")
			m.emitEvent("chat.reply", "system", map[string]any{"provider": t.Provider, "text": t.Text}, t.CorrelationID, "")
			return m, nil
		}
		if strings.TrimSpace(t.Error) != "" {
			if t.Status == 429 && t.Provider == "openai-oauth-codex" && t.Attempt == 0 {
				retryMs := t.RetryAfterMs
				if retryMs <= 0 {
					retryMs = 10_000
				}
				if err := setOAuthProfileRateLimitedUntil(m.cfg.stateDir, t.Profile, time.Now().Add(time.Duration(retryMs)*time.Millisecond).UnixMilli()); err == nil {
					// Choose next candidate deterministically (best-effort).
					if snap, ok := readOAuthPoolSnapshot(m.cfg.stateDir, time.Now()); ok {
						next, ok2 := firstNonLimitedExcept(snap.Ranked, t.Profile)
						if ok2 {
							_ = setOAuthPoolLastUsedProfile(m.cfg.stateDir, next.Profile)
							m.oauthFlashUntil = time.Now().Add(1 * time.Second)
							m.lastOAuthProfile = next.Email
							m.systemAlert(alertWarn, "auth.swap", fmt.Sprintf("Swapped OAuth Account -> %s (reason=rate_limit)", next.Email), map[string]any{"fromProfile": t.Profile, "toProfile": next.Profile})
							m.emitEvent("auth.swap", "system", map[string]any{
								"from":    t.Profile,
								"to":      next.Email,
								"reason":  "rate_limit",
								"ranking": snap.Ranked,
							}, t.CorrelationID, "")

							// Retry once with the same messages.
							if !m.cfg.disableNetwork {
								m.chatInFlight = true
								retryCID := newCorrelationID()
								m.chatCorrelationID = retryCID
								m.chatActiveProfile = next.Profile
								ctx, cancel := context.WithCancel(context.Background())
								m.chatCancel = cancel

								endpoint := strings.TrimSpace(snap.CodexEndpoint)
								model := codexModelForSelection(strings.TrimSpace(m.selectedModel))
								instructions := strings.TrimSpace(os.Getenv("WORKBENCH_SYSTEM_PROMPT"))
								msgs := append([]chatMessage{}, m.chatMessages...)
								profileCopy := next

								m.emitEvent("llm.request", "system", map[string]any{"provider": "openai-oauth-codex", "model": model, "profile": profileCopy.Profile, "retry": true}, retryCID, t.CorrelationID)
								return m, func() tea.Msg {
									text, statusErr, err := codexChatStream(ctx, endpoint, model, profileCopy.accessToken, profileCopy.accountID, instructions, msgs, func(delta string) {
										if strings.TrimSpace(delta) == "" {
											return
										}
										_ = appendCodexEvent(m.codexEventsPath, codexTurnEvent{
											Version:       1,
											Type:          "turn.event",
											CorrelationID: retryCID,
											At:            time.Now().UTC().Format(time.RFC3339Nano),
											Kind:          "delta",
											Message:       delta,
										})
									})
									if err != nil {
										cancelled := errorsIsContextCanceled(err)
										return chatReplyMsg{CorrelationID: retryCID, Provider: "openai-oauth-codex", Profile: profileCopy.Profile, Error: err.Error(), Cancelled: cancelled, Attempt: 1}
									}
									if statusErr != nil {
										return chatReplyMsg{CorrelationID: retryCID, Provider: "openai-oauth-codex", Profile: profileCopy.Profile, Error: statusErr.Error(), Status: statusErr.Status, RetryAfterMs: statusErr.RetryAfterMs, Attempt: 1}
									}
									return chatReplyMsg{CorrelationID: retryCID, Provider: "openai-oauth-codex", Profile: profileCopy.Profile, Text: text, Attempt: 1}
								}
							}
						}
					}
				}
			}
			m.systemAlert(alertError, "chat.failed", "Chat request failed", map[string]any{"provider": t.Provider, "error": t.Error, "status": t.Status})
		}
		return m, nil
	case usageFetchedMsg:
		m.usageFetchInFlight[t.Profile] = false
		if t.Data != nil {
			m.usageByProfile[t.Profile] = t.Data
			saveCachedUsage(m.cfg.stateDir, t.Profile, t.Data)
			m.systemAlert(alertInfo, "cache.download", fmt.Sprintf("Usage updated (%s)", t.Profile), map[string]any{"profile": t.Profile})
			m.emitEvent("cache.download", "system", map[string]any{"kind": "usage", "profile": t.Profile, "fetchedAt": t.Data.FetchedAt}, "", "")
		} else if strings.TrimSpace(t.Error) != "" {
			last := m.usageLastErrorNotified[t.Profile]
			if last.IsZero() || time.Since(last) > 30*time.Second {
				m.usageLastErrorNotified[t.Profile] = time.Now()
				m.systemAlert(alertWarn, "oauth.usage.fetch_failed", fmt.Sprintf("Usage fetch failed (%s)", t.Profile), map[string]any{"profile": t.Profile, "error": t.Error})
			}
		}
		return m, nil
	case time.Time:
		now := t
		var cmd tea.Cmd
		m, cmd = m.onTick(now)
		return m, cmd
	case tea.KeyMsg:
		if t.String() == "esc" {
			return m.handleEsc()
		}
		if t.String() == "q" && m.currentOverlay() == overlayNone && m.currentScreen() == screenLauncher {
			return m, tea.Quit
		}
		if t.Type == tea.KeyCtrlC {
			return m, tea.Quit
		}

		switch m.currentOverlay() {
		case overlayCommandPalette:
			return m.updateCommandPalette(t)
		case overlayModelSelect:
			return m.updateModelSelect(t)
		case overlayQuickActions:
			return m.updateQuickActions(t)
		case overlayQuitConfirm:
			return m.updateQuitConfirm(t)
		case overlayAuthSelect:
			return m.updateAuthSelect(t)
		case overlayStats:
			return m.updateStats(t)
		case overlaySystemInfo:
			return m.updateSystemInfo(t)
		case overlayProviderSelect:
			return m.updateProviderSelect(t)
		case overlayRuntimeSelect:
			return m.updateRuntimeSelect(t)
		default:
			// fallthrough to screen
		}

		switch m.currentScreen() {
		case screenLauncher:
			return m.updateLauncher(t)
		case screenProviderConfig:
			return m.updateProviderConfig(t)
		case screenCockpit:
			return m.updateCockpit(t)
		default:
			return m, nil
		}
	default:
		return m, nil
	}
}

func firstNonLimitedExcept(ranked []oauthPoolProfile, exceptProfile string) (oauthPoolProfile, bool) {
	for _, p := range ranked {
		if p.Profile == "" || p.Profile == exceptProfile {
			continue
		}
		if p.Status != "LIMITED" {
			return p, true
		}
	}
	return oauthPoolProfile{}, false
}

func (m appModel) activeOAuthProfile() (oauthPoolProfile, bool) {
	if len(m.oauthPool.Profiles) == 0 {
		return oauthPoolProfile{}, false
	}
	active := strings.TrimSpace(m.oauthPool.ActiveProfile)
	if active == "" && len(m.oauthPool.Ranked) > 0 {
		active = m.oauthPool.Ranked[0].Profile
	}
	for _, p := range m.oauthPool.Profiles {
		if p.Profile == active {
			return p, true
		}
	}
	for _, p := range m.oauthPool.Ranked {
		for _, full := range m.oauthPool.Profiles {
			if full.Profile == p.Profile {
				return full, true
			}
		}
	}
	return m.oauthPool.Profiles[0], true
}

func errorsIsContextCanceled(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

func tickCmd() tea.Cmd {
	return tea.Tick(100*time.Millisecond, func(t time.Time) tea.Msg { return t })
}

type chatMessage struct {
	Role    string
	Content string
}

type chatRoleLine struct {
	Role string // user|assistant|system
	Text string
}

type chatReplyMsg struct {
	CorrelationID string
	Provider      string
	Profile       string
	Text          string
	Error         string
	Status        int
	RetryAfterMs  int64
	Cancelled     bool
	Attempt       int
}

func (m appModel) currentScreen() screen {
	if len(m.screens) == 0 {
		return screenLauncher
	}
	return m.screens[len(m.screens)-1]
}

func (m appModel) pushScreen(s screen) appModel {
	m.screens = append(m.screens, s)
	m.emitEvent("ui.nav.push", m.actionSource, map[string]any{"screen": s.String(), "depth": len(m.screens)}, "", "")
	return m
}

func (m appModel) popScreen() appModel {
	if len(m.screens) <= 1 {
		return m
	}
	popped := m.screens[len(m.screens)-1]
	m.screens = m.screens[:len(m.screens)-1]
	m.emitEvent("ui.nav.pop", m.actionSource, map[string]any{"screen": popped.String(), "depth": len(m.screens)}, "", "")
	return m
}

func (m appModel) currentOverlay() overlay {
	if len(m.overlays) == 0 {
		return overlayNone
	}
	return m.overlays[len(m.overlays)-1]
}

func (m appModel) openOverlay(o overlay) appModel {
	m.overlays = append(m.overlays, o)
	m.emitEvent("ui.overlay.open", m.actionSource, map[string]any{"overlay": o.String(), "depth": len(m.overlays)}, "", "")
	return m
}

func (m appModel) closeOverlay() appModel {
	if len(m.overlays) == 0 {
		return m
	}
	popped := m.overlays[len(m.overlays)-1]
	m.overlays = m.overlays[:len(m.overlays)-1]
	m.emitEvent("ui.overlay.close", m.actionSource, map[string]any{"overlay": popped.String(), "depth": len(m.overlays)}, "", "")
	if popped == overlayQuickActions {
		m.quickActionsVisible = false
	}
	return m
}

func (m appModel) closeAllOverlays() appModel {
	for len(m.overlays) > 0 {
		m = m.closeOverlay()
	}
	return m
}

func (m appModel) handleEsc() (tea.Model, tea.Cmd) {
	// Priority:
	// 1) Close top overlay
	// 2) Pop screen stack
	// 3) Launcher root -> quit confirmation
	if m.currentOverlay() != overlayNone {
		m = m.closeOverlay()
		m.slashPending = false
		m.slashPendingUntil = time.Time{}
		return m, nil
	}
	if m.currentScreen() == screenCockpit && m.chatInFlight {
		if m.opencodeExecutorReady && m.selectedRuntime == "opencode-run" && strings.TrimSpace(m.chatCorrelationID) != "" {
			_ = appendOpencodeRequest(m.opencodeRequestsPath, opencodeTurnRequest{
				Version:       1,
				Type:          "cancel",
				CorrelationID: m.chatCorrelationID,
			})
			m.systemAlert(alertInfo, "chat.cancel.requested", "Cancellation requested", map[string]any{"backend": "opencode-runtime"})
			m.emitEvent("command.cancel.requested", m.actionSource, map[string]any{"kind": "chat", "backend": "opencode-runtime"}, "", "")
			return m, nil
		}
		if m.codexExecutorReady && m.selectedRuntime == "codex-cli" && strings.TrimSpace(m.chatCorrelationID) != "" {
			_ = appendCodexRequest(m.codexRequestsPath, codexTurnRequest{
				Version:       1,
				Type:          "cancel",
				CorrelationID: m.chatCorrelationID,
			})
			m.systemAlert(alertInfo, "chat.cancel.requested", "Cancellation requested", map[string]any{"backend": "codex-runtime"})
			m.emitEvent("command.cancel.requested", m.actionSource, map[string]any{"kind": "chat", "backend": "codex-runtime"}, "", "")
			return m, nil
		}
		if m.chatCancel != nil {
			m.chatCancel()
			m.chatCancel = nil
		}
		m.chatInFlight = false
		m.chatCorrelationID = ""
		m.chatActiveProfile = ""
		m.systemAlert(alertInfo, "chat.cancel.requested", "Cancellation requested", nil)
		m.emitEvent("command.cancel.requested", m.actionSource, map[string]any{"kind": "chat"}, "", "")
		return m, nil
	}
	if m.currentScreen() == screenCockpit && m.slashPending {
		m.slashPending = false
		m.slashPendingUntil = time.Time{}
		m.emitEvent("command.cancelled", m.actionSource, map[string]any{"namespace": "slash", "state": "pending"}, "", "")
		return m, nil
	}
	if m.currentScreen() != screenLauncher {
		m = m.popScreen()
		return m, nil
	}
	m = m.openOverlay(overlayQuitConfirm)
	return m, nil
}

func (m appModel) emitEvent(eventType string, source string, payload any, correlationID string, causationID string) {
	if m.events == nil {
		return
	}
	m.events.Append(source, eventType, payload, correlationID, causationID)
}

func (m *appModel) systemAlert(sev alertSeverity, code string, message string, context map[string]any) {
	cid := newCorrelationID()
	a := systemAlert{
		At:            time.Now().UTC().Format(time.RFC3339Nano),
		Severity:      sev,
		Code:          code,
		Message:       message,
		Context:       context,
		CorrelationID: cid,
	}
	m.alerts = append(m.alerts, a)
	if len(m.alerts) > 50 {
		m.alerts = m.alerts[len(m.alerts)-50:]
	}
	m.emitEvent("system.alert", "system", map[string]any{
		"severity":       string(sev),
		"code":           code,
		"message":        message,
		"context":        context,
		"correlation_id": cid,
	}, cid, "")
}

func (m appModel) onTick(now time.Time) (appModel, tea.Cmd) {
	m.now = now
	if m.slashPending && !m.slashPendingUntil.IsZero() && now.After(m.slashPendingUntil) {
		m.slashPending = false
		m.slashPendingUntil = time.Time{}
	}
	if !m.oauthFlashUntil.IsZero() && now.After(m.oauthFlashUntil) {
		m.oauthFlashUntil = time.Time{}
	}

	m.codexExecutorReady = isCodexExecutorReady(m.cfg.stateDir, m.sessionID, now)
	m = m.consumeCodexEvents(now)
	m = m.consumeCodexResponses(now)

	m.opencodeExecutorReady = isOpencodeExecutorReady(m.cfg.stateDir, m.sessionID, now)
	m = m.consumeOpencodeEvents(now)
	m = m.consumeOpencodeResponses(now)

	m.systemExecutorReady = isSystemExecutorReady(m.cfg.stateDir, m.sessionID, now)
	m = m.consumeSystemResponses(now)

	if snap, ok := readOAuthPoolSnapshot(m.cfg.stateDir, now); ok {
		profile := snap.ActiveEmail
		m.oauthPool = snap
		if m.lastOAuthProfile != "" && profile != "" && profile != m.lastOAuthProfile {
			m.oauthFlashUntil = now.Add(1 * time.Second)
			m.systemAlert(alertInfo, "auth.swap.detected", fmt.Sprintf("Swapped OAuth Account -> %s (reason=external)", profile), map[string]any{
				"from": m.lastOAuthProfile,
				"to":   profile,
			})
			m.emitEvent("auth.swap", "system", map[string]any{
				"from":    m.lastOAuthProfile,
				"to":      profile,
				"reason":  "external",
				"ranking": snap.Ranked,
			}, "", "")
		}
		if profile != "" {
			m.lastOAuthProfile = profile
		}
	}

	var busCmd tea.Cmd
	m, busCmd = m.consumeCommandBus()
	if m.quitRequested {
		return m, tea.Quit
	}
	var usageCmd tea.Cmd
	m, usageCmd = m.maybeScheduleUsageFetch(now)
	cmds := []tea.Cmd{tickCmd()}
	if busCmd != nil {
		cmds = append(cmds, busCmd)
	}
	if usageCmd != nil {
		cmds = append(cmds, usageCmd)
	}
	if len(cmds) == 1 {
		return m, cmds[0]
	}
	return m, tea.Batch(cmds...)
}

func (m appModel) consumeSystemResponses(now time.Time) appModel {
	if strings.TrimSpace(m.systemResponsesPath) == "" {
		return m
	}
	rs, newOffset := readSystemResponses(m.systemResponsesPath, m.systemResponsesOffset)
	m.systemResponsesOffset = newOffset
	for _, r := range rs {
		if r.Type != "system.result" {
			continue
		}
		if strings.TrimSpace(r.CorrelationID) == "" {
			continue
		}
		if m.systemCorrelationID == "" || r.CorrelationID != m.systemCorrelationID {
			continue
		}
		m.systemInFlight = false
		m.systemCorrelationID = ""
		rc := r
		m.systemLastResult = &rc

		ctx := map[string]any{"action": r.Action, "summary": r.Summary, "artifacts": r.Artifacts}
		if r.Ok {
			m.systemAlert(alertInfo, "system.action.ok", nonEmpty(r.Summary, "System action completed"), ctx)
		} else {
			m.systemAlert(alertError, "system.action.failed", nonEmpty(r.Summary, "System action failed"), ctx)
		}
		m.emitEvent("system.action.result", "system", map[string]any{
			"ok":      r.Ok,
			"action":  r.Action,
			"summary": r.Summary,
		}, r.CorrelationID, "")
	}
	_ = now
	return m
}

func (m appModel) consumeCodexResponses(now time.Time) appModel {
	if strings.TrimSpace(m.codexResponsesPath) == "" {
		return m
	}
	rs, newOffset := readCodexResponses(m.codexResponsesPath, m.codexResponsesOffset)
	m.codexResponsesOffset = newOffset
	for _, r := range rs {
		if r.Type != "turn.result" {
			continue
		}
		if strings.TrimSpace(r.CorrelationID) == "" {
			continue
		}
		if m.chatCorrelationID == "" || r.CorrelationID != m.chatCorrelationID {
			continue
		}

		m.chatInFlight = false
		m.chatCorrelationID = ""
		m.chatActiveProfile = ""
		m.chatStreamText = ""

		if !r.Ok {
			msg := nonEmpty(strings.TrimSpace(r.Error), "Codex runtime error")
			m.chatRoleLines = append(m.chatRoleLines, chatRoleLine{Role: "system", Text: msg})
			if len(m.chatRoleLines) > 250 {
				m.chatRoleLines = m.chatRoleLines[len(m.chatRoleLines)-250:]
			}
			m.systemAlert(alertError, "codex.runtime.error", msg, map[string]any{"correlationId": r.CorrelationID})
			continue
		}

		if strings.TrimSpace(r.Content) != "" {
			m.chatRoleLines = append(m.chatRoleLines, chatRoleLine{Role: "assistant", Text: strings.TrimRight(r.Content, "\n")})
		} else {
			m.chatRoleLines = append(m.chatRoleLines, chatRoleLine{Role: "assistant", Text: "(no content)"})
		}
		if len(m.chatRoleLines) > 250 {
			m.chatRoleLines = m.chatRoleLines[len(m.chatRoleLines)-250:]
		}
		if len(r.FileChanges) > 0 {
			m.systemAlert(alertInfo, "codex.runtime.file_changes", fmt.Sprintf("Codex changed %d file(s)", len(r.FileChanges)), map[string]any{"files": r.FileChanges})
		}
		m.emitEvent("llm.response", "system", map[string]any{"provider": "codex-runtime", "ok": true, "filesChanged": len(r.FileChanges)}, r.CorrelationID, "")
	}
	_ = now
	return m
}

func (m appModel) consumeCodexEvents(now time.Time) appModel {
	if strings.TrimSpace(m.codexEventsPath) == "" {
		return m
	}
	evs, newOffset := readCodexEvents(m.codexEventsPath, m.codexEventsOffset)
	m.codexEventsOffset = newOffset
	for _, ev := range evs {
		if strings.TrimSpace(ev.CorrelationID) == "" {
			continue
		}
		if m.chatCorrelationID == "" || ev.CorrelationID != m.chatCorrelationID {
			continue
		}
		kind := strings.TrimSpace(ev.Kind)
		msg := strings.TrimSpace(ev.Message)
		if msg == "" {
			continue
		}
		if kind == "delta" {
			m.chatStreamText += msg
			if len(m.chatStreamText) > 4000 {
				m.chatStreamText = m.chatStreamText[len(m.chatStreamText)-4000:]
			}
			continue
		}

		prefix := "Codex"
		if kind == "think" {
			prefix = "THINK"
		}
		if strings.TrimSpace(ev.Tool) != "" {
			prefix = "Codex/" + strings.TrimSpace(ev.Tool)
		}
		m.chatRoleLines = append(m.chatRoleLines, chatRoleLine{Role: "system", Text: prefix + ": " + msg})
		if len(m.chatRoleLines) > 250 {
			m.chatRoleLines = m.chatRoleLines[len(m.chatRoleLines)-250:]
		}
	}
	_ = now
	return m
}

func (m appModel) consumeOpencodeEvents(now time.Time) appModel {
	if strings.TrimSpace(m.opencodeEventsPath) == "" {
		return m
	}
	evs, newOffset := readOpencodeEvents(m.opencodeEventsPath, m.opencodeEventsOffset)
	m.opencodeEventsOffset = newOffset
	for _, ev := range evs {
		if strings.TrimSpace(ev.CorrelationID) == "" {
			continue
		}
		if m.chatCorrelationID == "" || ev.CorrelationID != m.chatCorrelationID {
			continue
		}
		msg := strings.TrimSpace(ev.Message)
		if msg == "" {
			continue
		}
		prefix := "OpenCode"
		if strings.TrimSpace(ev.Kind) == "think" {
			prefix = "THINK"
		}
		if strings.TrimSpace(ev.Tool) != "" {
			prefix = "OpenCode/" + strings.TrimSpace(ev.Tool)
		}
		m.chatRoleLines = append(m.chatRoleLines, chatRoleLine{Role: "system", Text: prefix + ": " + msg})
		if len(m.chatRoleLines) > 250 {
			m.chatRoleLines = m.chatRoleLines[len(m.chatRoleLines)-250:]
		}
	}
	_ = now
	return m
}

func (m appModel) consumeOpencodeResponses(now time.Time) appModel {
	if strings.TrimSpace(m.opencodeResponsesPath) == "" {
		return m
	}
	rs, newOffset := readOpencodeResponses(m.opencodeResponsesPath, m.opencodeResponsesOffset)
	m.opencodeResponsesOffset = newOffset
	for _, r := range rs {
		if r.Type != "turn.result" {
			continue
		}
		if strings.TrimSpace(r.CorrelationID) == "" {
			continue
		}
		if m.chatCorrelationID == "" || r.CorrelationID != m.chatCorrelationID {
			continue
		}

		m.chatInFlight = false
		m.chatCorrelationID = ""
		m.chatActiveProfile = ""

		if !r.Ok {
			msg := nonEmpty(strings.TrimSpace(r.Error), "OpenCode runtime error")
			m.chatRoleLines = append(m.chatRoleLines, chatRoleLine{Role: "system", Text: msg})
			m.systemAlert(alertError, "opencode.runtime.error", msg, map[string]any{"correlationId": r.CorrelationID})
			continue
		}

		if strings.TrimSpace(r.Content) != "" {
			m.chatRoleLines = append(m.chatRoleLines, chatRoleLine{Role: "assistant", Text: strings.TrimRight(r.Content, "\n")})
		} else {
			m.chatRoleLines = append(m.chatRoleLines, chatRoleLine{Role: "assistant", Text: "(no content)"})
		}
		if len(r.FileChanges) > 0 {
			m.systemAlert(alertInfo, "opencode.runtime.file_changes", fmt.Sprintf("OpenCode changed %d file(s)", len(r.FileChanges)), map[string]any{"files": r.FileChanges})
		}
		m.emitEvent("llm.response", "system", map[string]any{"provider": "opencode-runtime", "ok": true, "filesChanged": len(r.FileChanges)}, r.CorrelationID, "")
	}
	_ = now
	return m
}

type usageFetchedMsg struct {
	Profile string
	Data    *usageData
	Error   string
}

func (m appModel) maybeScheduleUsageFetch(now time.Time) (appModel, tea.Cmd) {
	if m.cfg.disableNetwork {
		return m, nil
	}
	if len(m.oauthPool.Profiles) == 0 {
		return m, nil
	}

	ordered := orderOAuthProfilesForDisplay(m.oauthPool.Profiles)
	maxFetch := 2
	if len(ordered) < maxFetch {
		maxFetch = len(ordered)
	}

	for i := 0; i < maxFetch; i++ {
		p := ordered[i]
		if p.Profile == "" || strings.TrimSpace(p.accessToken) == "" {
			continue
		}

		// Cache hit path first (avoid network).
		if cached, ok := loadCachedUsage(m.cfg.stateDir, p.Profile, now); ok && cached != nil {
			m.usageByProfile[p.Profile] = cached
			if m.usageLastCacheNotified[p.Profile] != cached.FetchedAt {
				m.usageLastCacheNotified[p.Profile] = cached.FetchedAt
				m.systemAlert(alertInfo, "cache.hit", fmt.Sprintf("Usage cache hit (%s)", p.Profile), map[string]any{"profile": p.Profile})
				m.emitEvent("cache.hit", "system", map[string]any{"kind": "usage", "profile": p.Profile, "fetchedAt": cached.FetchedAt}, "", "")
			}
			continue
		}

		// If we have recent in-memory usage, don't refetch.
		if u := m.usageByProfile[p.Profile]; u != nil && u.FetchedAt > 0 {
			if now.Sub(time.UnixMilli(u.FetchedAt)) < usageCacheTTL {
				continue
			}
		}

		if m.usageFetchInFlight[p.Profile] {
			continue
		}
		m.usageFetchInFlight[p.Profile] = true

		m.systemAlert(alertInfo, "cache.miss", fmt.Sprintf("Usage cache miss (%s)", p.Profile), map[string]any{"profile": p.Profile})
		m.emitEvent("cache.miss", "system", map[string]any{"kind": "usage", "profile": p.Profile}, "", "")

		token := p.accessToken
		accountID := p.accountID
		profile := p.Profile
		return m, func() tea.Msg {
			u, err := fetchUsage(token, accountID)
			if err != nil {
				return usageFetchedMsg{Profile: profile, Data: nil, Error: err.Error()}
			}
			return usageFetchedMsg{Profile: profile, Data: u, Error: ""}
		}
	}
	return m, nil
}

func (m appModel) updateLauncher(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.Type {
	case tea.KeyUp:
		if m.launcherSelected > 0 {
			m.launcherSelected--
		}
	case tea.KeyDown:
		if m.launcherSelected < 1 {
			m.launcherSelected++
		}
	case tea.KeyEnter:
		if m.launcherSelected == 0 {
			m.mode = modeA
		} else {
			m.mode = modeB
		}
		m = m.pushScreen(screenProviderConfig)
	}
	return m, nil
}

func (m appModel) updateProviderConfig(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.Type {
	case tea.KeyTab:
		if m.mode == modeA {
			m.providerFocus = (m.providerFocus + 1) % 2
		}
	case tea.KeyUp:
		m = m.bumpProvider(-1)
	case tea.KeyDown:
		m = m.bumpProvider(1)
	case tea.KeyEnter:
		m = m.pushScreen(screenCockpit)
		m.systemAlert(alertInfo, "mode.selected", fmt.Sprintf("Mode %s selected", m.mode.String()), nil)
		return m, nil
	}
	return m, nil
}

func (m appModel) bumpProvider(delta int) appModel {
	opts := providerOptions()
	max := len(opts) - 1
	if m.mode == modeA {
		if m.providerFocus == 0 {
			m.providerSelectedA = clamp(m.providerSelectedA+delta, 0, max)
		} else {
			m.providerSelectedB = clamp(m.providerSelectedB+delta, 0, max)
		}
		return m
	}
	m.providerSelected = clamp(m.providerSelected+delta, 0, max)
	m.selectedProvider = opts[m.providerSelected]
	m.selectedRuntime = defaultRuntimeForProvider(m.selectedProvider)
	return m
}

func (m appModel) updateCockpit(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if k.Type == tea.KeyEnter && strings.TrimSpace(m.input) == "" {
		m = m.openOverlay(overlayQuickActions)
		m.quickActionsVisible = true
		return m, nil
	}

	switch k.Type {
	case tea.KeyBackspace:
		if m.slashPending && strings.TrimSpace(m.input) == "" {
			m.slashPending = false
			m.slashPendingUntil = time.Time{}
			m.emitEvent("command.cancelled", m.actionSource, map[string]any{"namespace": "slash", "state": "pending", "by": "backspace"}, "", "")
			return m, nil
		}
		if len(m.input) > 0 {
			m.input = m.input[:len(m.input)-1]
		}
	case tea.KeyRunes:
		if len(k.Runes) == 1 && k.Runes[0] == '/' && strings.TrimSpace(m.input) == "" && m.currentOverlay() == overlayNone {
			// Open palette immediately (session namespace). If user types a 2nd slash while query is empty,
			// promote to system namespace.
			m.slashPending = true
			m.slashPendingUntil = time.Now().Add(200 * time.Millisecond)
			m.commandPaletteNamespace = "/"
			m = m.openOverlay(overlayCommandPalette)
			m.commandPaletteQuery = ""
			m.commandPaletteIndex = 0
			return m, nil
		}

		m.input += string(k.Runes)
	case tea.KeySpace:
		m.input += " "
	case tea.KeyEnter:
		line := strings.TrimSpace(m.input)
		if line != "" {
			if strings.HasPrefix(line, "/") {
				var cmd tea.Cmd
				m, cmd = m.executeCommandText(line)
				m.input = ""
				return m, cmd
			}
			var cmd tea.Cmd
			m, cmd = m.sendChat(line)
			m.input = ""
			return m, cmd
		}
		m.input = ""
	}
	return m, nil
}

func (m appModel) updateCommandPalette(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if k.Type == tea.KeyRunes && len(k.Runes) == 1 && k.Runes[0] == '/' && m.commandPaletteQuery == "" && m.commandPaletteNamespace == "/" {
		// Deterministic promotion: a second '/' with an empty query always enters the system namespace.
		m.commandPaletteNamespace = "//"
		m.commandPaletteQuery = ""
		m.commandPaletteIndex = 0
		m.slashPending = false
		m.slashPendingUntil = time.Time{}
		return m, nil
	}

	if k.Type == tea.KeyBackspace {
		if len(m.commandPaletteQuery) == 0 {
			m = m.closeOverlay()
			return m, nil
		}
		m.commandPaletteQuery = m.commandPaletteQuery[:len(m.commandPaletteQuery)-1]
		m.commandPaletteIndex = 0
		return m, nil
	}

	if k.Type == tea.KeyRunes && len(k.Runes) > 0 {
		m.commandPaletteQuery += string(k.Runes)
		m.commandPaletteIndex = 0
		return m, nil
	}
	if k.Type == tea.KeySpace {
		m.commandPaletteQuery += " "
		m.commandPaletteIndex = 0
		return m, nil
	}

	items := filteredCommandPaletteItems(m.commandPaletteNamespace, m.commandPaletteQuery)
	if len(items) == 0 {
		if k.Type == tea.KeyEnter {
			m = m.closeOverlay()
		}
		return m, nil
	}

	switch k.Type {
	case tea.KeyUp:
		if m.commandPaletteIndex > 0 {
			m.commandPaletteIndex--
		}
	case tea.KeyDown:
		if m.commandPaletteIndex < len(items)-1 {
			m.commandPaletteIndex++
		}
	case tea.KeyEnter:
		item := items[m.commandPaletteIndex]
		return m.applyCommandPalette(item)
	}
	return m, nil
}

func (m appModel) applyCommandPalette(item paletteItem) (tea.Model, tea.Cmd) {
	m.slashPending = false
	m.slashPendingUntil = time.Time{}

	ns := m.commandPaletteNamespace
	if ns != "//" {
		ns = "/"
	}
	text := ns + item.cmd
	if ns == "//" {
		text = "//" + item.cmd
	}
	m.recentCommands = append(m.recentCommands, text)
	if len(m.recentCommands) > 20 {
		m.recentCommands = m.recentCommands[len(m.recentCommands)-20:]
	}

	if ns == "//" {
		// Record command submission for system commands too (except docker/verify which emit in their helpers with correlation IDs).
		if item.action != "docker" && item.action != "verify" {
			m.emitEvent("command.submitted", m.actionSource, map[string]any{"namespace": ns, "text": text}, "", "")
		}
		switch item.action {
		case "provider":
			m = m.openOverlay(overlayProviderSelect)
			m.providerSelectIndex = 0
			return m, nil
		case "runtime":
			m = m.openOverlay(overlayRuntimeSelect)
			m.runtimeSelectIndex = 0
			return m, nil
		case "model":
			m = m.openOverlay(overlayModelSelect)
			m.modelSelectIndex = 0
			return m, nil
		case "auth":
			m = m.openOverlay(overlayAuthSelect)
			m.authSelectIndex = 0
			return m, nil
		case "mode":
			if m.mode == modeA {
				m.mode = modeB
			} else {
				m.mode = modeA
			}
			m.systemAlert(alertInfo, "mode.switched", fmt.Sprintf("Mode switched to %s", m.mode.String()), nil)
			m = m.closeAllOverlays()
			return m, nil
		case "stats":
			m = m.openOverlay(overlayStats)
			return m, nil
		case "docker":
			return m.submitSystemDockerProbe("")
		case "verify":
			return m.submitSystemVerify(false, "")
		case "exit":
			return m, tea.Quit
		default:
			m.systemAlert(alertError, "system.command", "System command not implemented", map[string]any{"cmd": item.cmd})
			m = m.closeAllOverlays()
			return m, nil
		}
	}

	m.emitEvent("command.submitted", m.actionSource, map[string]any{"namespace": ns, "text": text}, "", "")

	switch item.action {
	case "auth":
		m = m.openOverlay(overlayAuthSelect)
		m.authSelectIndex = 0
		return m, nil
	case "exit":
		return m, tea.Quit
	case "model":
		m = m.openOverlay(overlayModelSelect)
		m.modelSelectIndex = 0
		return m, nil
	case "mode":
		if m.mode == modeA {
			m.mode = modeB
		} else {
			m.mode = modeA
		}
		m.systemAlert(alertInfo, "mode.switched", fmt.Sprintf("Mode switched to %s", m.mode.String()), nil)
		m = m.closeAllOverlays()
		return m, nil
	case "stats":
		m = m.openOverlay(overlayStats)
		return m, nil
	case "clear":
		m.chatLines = []string{}
		m.chatRoleLines = []chatRoleLine{}
		m.chatMessages = []chatMessage{}
		m.systemAlert(alertInfo, "chat.cleared", "Chat cleared", nil)
		m = m.closeAllOverlays()
		return m, nil
	default:
		m.systemAlert(alertInfo, "command.executed", item.label, map[string]any{"cmd": item.cmd})
		m = m.closeOverlay()
		return m, nil
	}
}

func (m appModel) submitSystemVerify(full bool, correlationID string) (tea.Model, tea.Cmd) {
	if !m.systemExecutorReady && !isSystemExecutorReady(m.cfg.stateDir, m.sessionID, m.now) {
		m.systemAlert(alertError, "system.executor.unavailable", "System executor not ready", map[string]any{"hint": "run workbench from a real terminal; ensure node+bun are installed"})
		m = m.closeAllOverlays()
		return m, nil
	}
	if m.systemInFlight {
		m.systemAlert(alertWarn, "system.busy", "A system action is already in flight", nil)
		m = m.closeAllOverlays()
		return m, nil
	}
	cid := strings.TrimSpace(correlationID)
	if cid == "" {
		cid = newCorrelationID()
	}
	m.systemInFlight = true
	m.systemCorrelationID = cid
	_ = appendSystemRequest(m.systemRequestsPath, systemRequest{
		Version:       1,
		Type:          "verify",
		CorrelationID: cid,
		Full:          full,
	})
	cmdText := "//verify"
	if full {
		cmdText = "//verify full"
	}
	m.systemAlert(alertInfo, "system.verify.requested", "Verification requested", map[string]any{"full": full, "correlationId": cid})
	m.emitEvent("command.submitted", m.actionSource, map[string]any{"namespace": "//", "text": cmdText}, cid, "")
	m = m.closeAllOverlays()
	m = m.openOverlay(overlaySystemInfo)
	return m, nil
}

func (m appModel) submitSystemDockerProbe(correlationID string) (tea.Model, tea.Cmd) {
	if !m.systemExecutorReady && !isSystemExecutorReady(m.cfg.stateDir, m.sessionID, m.now) {
		m.systemAlert(alertError, "system.executor.unavailable", "System executor not ready", map[string]any{"hint": "run workbench from a real terminal; ensure node+bun are installed"})
		m = m.closeAllOverlays()
		return m, nil
	}
	if m.systemInFlight {
		m.systemAlert(alertWarn, "system.busy", "A system action is already in flight", nil)
		m = m.closeAllOverlays()
		return m, nil
	}
	cid := strings.TrimSpace(correlationID)
	if cid == "" {
		cid = newCorrelationID()
	}
	m.systemInFlight = true
	m.systemCorrelationID = cid
	_ = appendSystemRequest(m.systemRequestsPath, systemRequest{
		Version:       1,
		Type:          "docker.probe",
		CorrelationID: cid,
	})
	m.systemAlert(alertInfo, "system.docker.probe", "Docker probe requested", map[string]any{"correlationId": cid})
	m.emitEvent("command.submitted", m.actionSource, map[string]any{"namespace": "//", "text": "//docker probe"}, cid, "")
	m = m.closeAllOverlays()
	m = m.openOverlay(overlaySystemInfo)
	return m, nil
}

func (m appModel) sendChat(line string) (appModel, tea.Cmd) {
	txt := strings.TrimSpace(line)
	if txt == "" {
		return m, nil
	}
	if m.chatInFlight {
		m.systemAlert(alertWarn, "chat.busy", "A chat request is already in flight", nil)
		return m, nil
	}

	cid := newCorrelationID()
	m.chatRoleLines = append(m.chatRoleLines, chatRoleLine{Role: "user", Text: txt})
	m.chatMessages = append(m.chatMessages, chatMessage{Role: "user", Content: txt})
	m.emitEvent("chat.send", m.actionSource, map[string]any{"text": txt, "provider": m.selectedProvider, "runtime": m.selectedRuntime}, cid, "")

	runtime := strings.TrimSpace(m.selectedRuntime)
	provider := m.selectedProviderLabel()
	compatLabel := getCompatibilityLabel(provider, runtime)

	// Claude Code runtime (native TTY)
	if runtime == "claude-code" {
		m.systemAlert(alertWarn, "claude.native.surface", "Claude Code is a native TTY surface and is not wired into this managed cockpit yet", map[string]any{"hint": "Run `claude` in a terminal (or use tmux integration via other UI surfaces)"})
		return m, nil
	}

	// Direct API runtime - not implemented (requires API keys we don't have)
	if runtime == "direct-api" {
		m.systemAlert(alertWarn, "direct.api.wip", "Direct API runtime is not yet implemented", map[string]any{"hint": "Use Codex – Chat Mode or Codex – CLI Mode instead"})
		return m, nil
	}

	// Codex CLI Mode - uses local Codex executor for file edits
	if runtime == "codex-cli" {
		ready := m.codexExecutorReady || isCodexExecutorReady(m.cfg.stateDir, m.sessionID, m.now)
		if ready {
			m.codexExecutorReady = true
			m.chatInFlight = true
			m.chatCorrelationID = cid
			m.chatActiveProfile = m.oauthPool.ActiveProfile
			model := codexModelForSelection(strings.TrimSpace(m.selectedModel))
			cwd := extractCwdFromPrompt(txt)
			if strings.TrimSpace(cwd) == "" {
				cwd = "."
			}
			_ = appendCodexRequest(m.codexRequestsPath, codexTurnRequest{
				Version:       1,
				Type:          "turn",
				CorrelationID: cid,
				Prompt:        txt,
				Cwd:           cwd,
				Model:         model,
				NoShell:       true,
				Think:         m.thoughtStream,
			})
			m.systemAlert(alertInfo, "codex.cli.turn", "Submitted to Codex CLI", map[string]any{"cwd": cwd, "model": model, "think": m.thoughtStream, "runtime": "codex-cli", "compatibility": compatLabel})
			return m, nil
		}
		m.systemAlert(alertError, "codex.cli.unavailable", "Codex CLI executor not ready", map[string]any{"hint": "Start workbench from a terminal with `codex` installed, or switch runtime to Codex – Chat Mode"})
		return m, nil
	}

	// OpenCode Run Mode - uses host-side OpenCode executor (streams tool/step events)
	if runtime == "opencode-run" {
		ready := m.opencodeExecutorReady || isOpencodeExecutorReady(m.cfg.stateDir, m.sessionID, m.now)
		if ready {
			m.opencodeExecutorReady = true
			m.chatInFlight = true
			m.chatCorrelationID = cid
			m.chatActiveProfile = ""
			model := opencodeModelForSelection(provider, strings.TrimSpace(m.selectedModel))
			agent := opencodeAgent()
			think := m.thoughtStream
			cwd := extractCwdFromPrompt(txt)
			if strings.TrimSpace(cwd) == "" {
				cwd = "."
			}
			_ = appendOpencodeRequest(m.opencodeRequestsPath, opencodeTurnRequest{
				Version:       1,
				Type:          "turn",
				CorrelationID: cid,
				Prompt:        txt,
				Cwd:           cwd,
				Model:         model,
				Agent:         agent,
				Think:         think,
			})
			m.systemAlert(alertInfo, "opencode.run.turn", "Submitted to OpenCode", map[string]any{"cwd": cwd, "model": model, "agent": agent, "think": think, "runtime": "opencode-run", "compatibility": compatLabel})
			return m, nil
		}
		m.systemAlert(alertError, "opencode.run.unavailable", "OpenCode executor not ready", map[string]any{"hint": "Install `opencode` and restart workbench, or switch runtime"})
		return m, nil
	}

	// Codex Chat Mode - uses OAuth API (chat-only, no file edits)
	if runtime == "codex-chat" {
		p, ok := m.activeOAuthProfile()
		if !ok {
			m.systemAlert(alertError, "auth.pool.empty", "OpenAI OAuth pool is empty/unavailable", nil)
			return m, nil
		}
		m.chatInFlight = true
		m.chatCorrelationID = cid
		m.chatActiveProfile = p.Profile
		m.chatStreamText = ""
		ctx, cancel := context.WithCancel(context.Background())
		m.chatCancel = cancel

		endpoint := strings.TrimSpace(m.oauthPool.CodexEndpoint)
		model := codexModelForSelection(strings.TrimSpace(m.selectedModel))
		instructions := strings.TrimSpace(os.Getenv("WORKBENCH_SYSTEM_PROMPT"))
		msgs := append([]chatMessage{}, m.chatMessages...)
		eventsPath := m.codexEventsPath

		m.emitEvent("llm.request", "system", map[string]any{"provider": "openai-oauth-codex", "model": model, "profile": p.Profile, "runtime": "codex-chat"}, cid, "")
		return m, func() tea.Msg {
			if m.thoughtStream {
				planInstructions := strings.TrimSpace(instructions + "\n\nYou are in planning mode. Output only a concise bullet plan of steps. Do not produce the final answer.")
				planText, planStatusErr, planErr := codexChatOnce(ctx, endpoint, model, p.accessToken, p.accountID, planInstructions, msgs)
				if planErr != nil {
					cancelled := errorsIsContextCanceled(planErr)
					return chatReplyMsg{CorrelationID: cid, Provider: "openai-oauth-codex", Profile: p.Profile, Error: planErr.Error(), Cancelled: cancelled, Attempt: 0}
				}
				if planStatusErr != nil {
					return chatReplyMsg{
						CorrelationID: cid,
						Provider:      "openai-oauth-codex",
						Profile:       p.Profile,
						Error:         planStatusErr.Error(),
						Status:        planStatusErr.Status,
						RetryAfterMs:  planStatusErr.RetryAfterMs,
						Cancelled:     false,
						Attempt:       0,
					}
				}
				for _, line := range strings.Split(planText, "\n") {
					l := strings.TrimSpace(line)
					if l == "" {
						continue
					}
					_ = appendCodexEvent(eventsPath, codexTurnEvent{
						Version:       1,
						Type:          "turn.event",
						CorrelationID: cid,
						At:            time.Now().UTC().Format(time.RFC3339Nano),
						Kind:          "think",
						Message:       l,
					})
				}
			}

			text, statusErr, err := codexChatStream(ctx, endpoint, model, p.accessToken, p.accountID, instructions, msgs, func(delta string) {
				if strings.TrimSpace(delta) == "" {
					return
				}
				_ = appendCodexEvent(eventsPath, codexTurnEvent{
					Version:       1,
					Type:          "turn.event",
					CorrelationID: cid,
					At:            time.Now().UTC().Format(time.RFC3339Nano),
					Kind:          "delta",
					Message:       delta,
				})
			})
			if err != nil {
				cancelled := errorsIsContextCanceled(err)
				return chatReplyMsg{CorrelationID: cid, Provider: "openai-oauth-codex", Profile: p.Profile, Error: err.Error(), Cancelled: cancelled, Attempt: 0}
			}
			if statusErr != nil {
				return chatReplyMsg{
					CorrelationID: cid,
					Provider:      "openai-oauth-codex",
					Profile:       p.Profile,
					Error:         statusErr.Error(),
					Status:        statusErr.Status,
					RetryAfterMs:  statusErr.RetryAfterMs,
					Cancelled:     false,
					Attempt:       0,
				}
			}
			return chatReplyMsg{CorrelationID: cid, Provider: "openai-oauth-codex", Profile: p.Profile, Text: text, Attempt: 0}
		}
	}

	m.systemAlert(alertWarn, "chat.unavailable", fmt.Sprintf("Runtime '%s' with provider '%s' is not wired in the managed cockpit yet", runtime, provider), map[string]any{"provider": provider, "runtime": runtime, "compatibility": compatLabel})
	return m, nil
}

func (m appModel) updateModelSelect(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	items := modelOptions()
	if len(items) == 0 {
		m = m.closeAllOverlays()
		return m, nil
	}

	// Clamp index to valid range
	if m.modelSelectIndex >= len(items) {
		m.modelSelectIndex = len(items) - 1
	}

	switch k.Type {
	case tea.KeyUp:
		if m.modelSelectIndex > 0 {
			m.modelSelectIndex--
		}
	case tea.KeyDown:
		if m.modelSelectIndex < len(items)-1 {
			m.modelSelectIndex++
		}
	case tea.KeyEnter:
		m.selectedModel = items[m.modelSelectIndex]
		m.systemAlert(alertInfo, "model.set", fmt.Sprintf("Model set to %s", m.selectedModel), map[string]any{"model": m.selectedModel})
		m = m.closeAllOverlays()
	}

	return m, nil
}

func (m appModel) updateQuickActions(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.Type {
	case tea.KeyUp:
		if m.quickActionsIndex > 0 {
			m.quickActionsIndex--
		}
	case tea.KeyDown:
		if m.quickActionsIndex < len(quickActionItems())-1 {
			m.quickActionsIndex++
		}
	case tea.KeyEnter:
		item := quickActionItems()[m.quickActionsIndex]
		switch item {
		case "Switch Provider":
			m = m.closeOverlay()
			m = m.openOverlay(overlayProviderSelect)
			m.providerSelectIndex = 0
			return m, nil
		case "Switch Runtime":
			m = m.closeOverlay()
			m = m.openOverlay(overlayRuntimeSelect)
			m.runtimeSelectIndex = 0
			return m, nil
		case "Change Mode":
			m = m.closeOverlay()
			if m.mode == modeA {
				m.mode = modeB
			} else {
				m.mode = modeA
			}
			m.systemAlert(alertInfo, "mode.switched", fmt.Sprintf("Mode switched to %s", m.mode.String()), nil)
			return m, nil
		case "Toggle Thought Stream":
			m.thoughtStream = !m.thoughtStream
			status := "disabled"
			if m.thoughtStream {
				status = "enabled"
			}
			m.systemAlert(alertInfo, "thought_stream.toggled", "Thought stream "+status, map[string]any{"enabled": m.thoughtStream})
			m = m.closeOverlay()
			return m, nil
		default:
			m.systemAlert(alertInfo, "quick_action", item, nil)
			m = m.closeOverlay()
		}
	}
	return m, nil
}

func (m appModel) updateQuitConfirm(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.Type {
	case tea.KeyEnter:
		m.emitEvent("command.submitted", m.actionSource, map[string]any{"namespace": "ui", "text": "quit.confirm"}, "", "")
		m.recentCommands = append(m.recentCommands, "quit.confirm")
		return m, tea.Quit
	case tea.KeyRunes:
		if string(k.Runes) == "y" || string(k.Runes) == "Y" {
			m.emitEvent("command.submitted", m.actionSource, map[string]any{"namespace": "ui", "text": "quit.y"}, "", "")
			m.recentCommands = append(m.recentCommands, "quit.y")
			return m, tea.Quit
		}
		if string(k.Runes) == "n" || string(k.Runes) == "N" {
			m.emitEvent("command.submitted", m.actionSource, map[string]any{"namespace": "ui", "text": "quit.n"}, "", "")
			m.recentCommands = append(m.recentCommands, "quit.n")
			m = m.closeOverlay()
			return m, nil
		}
	}
	return m, nil
}

func (m appModel) updateAuthSelect(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	profiles := orderOAuthProfilesForDisplay(m.oauthPool.Profiles)
	if len(profiles) == 0 {
		m.systemAlert(alertWarn, "auth.pool.empty", "OAuth pool is empty", nil)
		m = m.closeOverlay()
		return m, nil
	}
	switch k.Type {
	case tea.KeyUp:
		if m.authSelectIndex > 0 {
			m.authSelectIndex--
		}
	case tea.KeyDown:
		if m.authSelectIndex < len(profiles)-1 {
			m.authSelectIndex++
		}
	case tea.KeyEnter:
		target := profiles[m.authSelectIndex]
		from := m.oauthPool.ActiveEmail
		if err := setOAuthPoolLastUsedProfile(m.cfg.stateDir, target.Profile); err != nil {
			m.systemAlert(alertError, "auth.select.failed", "Failed to select OAuth profile", map[string]any{"error": err.Error()})
			m = m.closeOverlay()
			return m, nil
		}
		m.oauthFlashUntil = time.Now().Add(1 * time.Second)
		m.oauthPool.ActiveProfile = target.Profile
		m.oauthPool.ActiveEmail = target.Email
		m.lastOAuthProfile = target.Email
		m.systemAlert(alertInfo, "auth.swap", fmt.Sprintf("Swapped OAuth Account -> %s (reason=user)", target.Email), map[string]any{
			"from":   from,
			"to":     target.Email,
			"profile": target.Profile,
		})
		m.emitEvent("auth.swap", "system", map[string]any{
			"from":    from,
			"to":      target.Email,
			"reason":  "user",
			"ranking": m.oauthPool.Ranked,
		}, "", "")
		m = m.closeOverlay()
	}
	return m, nil
}

func (m appModel) updateStats(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.Type {
	case tea.KeyEnter:
		m = m.closeOverlay()
	}
	return m, nil
}

func (m appModel) updateSystemInfo(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.Type {
	case tea.KeyEnter:
		m = m.closeOverlay()
	}
	return m, nil
}

func (m appModel) updateProviderSelect(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	opts := providerOptions()
	if len(opts) == 0 {
		m = m.closeAllOverlays()
		return m, nil
	}
	switch k.Type {
	case tea.KeyUp:
		if m.providerSelectIndex > 0 {
			m.providerSelectIndex--
		}
	case tea.KeyDown:
		if m.providerSelectIndex < len(opts)-1 {
			m.providerSelectIndex++
		}
	case tea.KeyEnter:
		if m.mode == modeA {
			m.systemAlert(alertWarn, "provider.select.mode_a", "Provider selection for Mode A is not wired in cockpit yet (use provider config step)", nil)
			m = m.closeAllOverlays()
			return m, nil
		}
		m.providerSelected = m.providerSelectIndex
		m.selectedProvider = opts[m.providerSelectIndex]
		m.selectedRuntime = defaultRuntimeForProvider(m.selectedProvider)
		compat := getCompatibilityLabel(m.selectedProvider, m.selectedRuntime)
		m.systemAlert(alertInfo, "provider.set", fmt.Sprintf("Provider set to %s (%s)", m.selectedProvider, compat), map[string]any{"provider": m.selectedProvider, "runtime": m.selectedRuntime, "compatibility": compat})
		m = m.closeAllOverlays()
	}
	return m, nil
}

type runtimeOption struct {
	ID    string
	Label string
}

// runtimeOptionsForProvider returns all unified runtime options with compatibility info
func runtimeOptionsForProvider(providerLabel string) []runtimeOption {
	unified := runtimeOptionsUnified()
	opts := make([]runtimeOption, 0, len(unified))
	for _, u := range unified {
		compat := getCompatibility(providerLabel, u.ID)
		label := u.Label
		if compat == compatProxy {
			label = label + " [proxy]"
		}
		opts = append(opts, runtimeOption{ID: u.ID, Label: label})
	}
	return opts
}

func defaultRuntimeForProvider(providerLabel string) string {
	p := strings.ToLower(strings.TrimSpace(providerLabel))
	switch {
	case strings.Contains(p, "anthropic"):
		return "claude-code"
	case strings.Contains(p, "openai"):
		return "codex-cli"
	default:
		return "direct-api"
	}
}

// Deprecated: use defaultRuntimeForProvider
func defaultRuntimeForProviderLabel(providerLabel string) string {
	return defaultRuntimeForProvider(providerLabel)
}

func (m appModel) updateRuntimeSelect(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	unified := runtimeOptionsUnified()
	if len(unified) == 0 {
		m = m.closeAllOverlays()
		return m, nil
	}
	switch k.Type {
	case tea.KeyUp:
		if m.runtimeSelectIndex > 0 {
			m.runtimeSelectIndex--
		}
	case tea.KeyDown:
		if m.runtimeSelectIndex < len(unified)-1 {
			m.runtimeSelectIndex++
		}
	case tea.KeyEnter:
		selected := unified[m.runtimeSelectIndex]
		m.selectedRuntime = selected.ID
		compat := getCompatibilityLabel(m.selectedProvider, m.selectedRuntime)
		m.systemAlert(alertInfo, "runtime.set", fmt.Sprintf("Runtime set to %s (%s)", selected.Label, compat), map[string]any{"runtime": m.selectedRuntime, "compatibility": compat})
		m = m.closeAllOverlays()
	}
	return m, nil
}

func (m appModel) View() string {
	w, h := m.effectiveSize()
	// If the terminal is extremely small, render a stable hint instead of a broken layout.
	if w < 20 || h < 6 {
		return m.viewTooSmall(w, h)
	}

	switch m.currentScreen() {
	case screenLauncher:
		return m.viewLauncher()
	case screenProviderConfig:
		return m.viewProviderConfig()
	case screenCockpit:
		return m.viewCockpit()
	default:
		return "unknown screen"
	}
}

func (m appModel) viewLauncher() string {
	header := renderHeader(m.th, m.cfg.applicationV, m.mcpConnected, m.sessionID)

	lines := []string{
		fmt.Sprintf("TARGET SYSTEM: %s", m.cfg.targetSystem),
		fmt.Sprintf("SESSION ID:    %s", m.sessionID),
		"",
		m.th.Muted.Render("┌─ STEP 1: SELECT OPERATION MODE ────────────────────────────────────────┐"),
	}

	items := []string{
		"[A] CONTROLLED MODE",
		"[B] COMPATIBILITY MODE",
	}
	for i, it := range items {
		prefix := "  "
		if i == m.launcherSelected {
			prefix = m.th.Accent.Render("> ")
			it = m.th.Accent.Render(it)
		}
		lines = append(lines, prefix+it)
	}

	lines = append(lines,
		m.th.Muted.Render(""),
		m.th.Muted.Render("[Up/Down] Navigate    [Enter] Select    [q] Quit"),
	)

	body := strings.Join(lines, "\n")
	frame := m.th.Frame
	if w, _ := m.effectiveSize(); w >= 4 {
		frame = frame.Width(w - 2)
	}
	return frame.Render(header + "\n" + body)
}

func (m appModel) viewProviderConfig() string {
	header := renderHeader(m.th, m.cfg.applicationV, m.mcpConnected, m.sessionID)

	lines := []string{
		m.th.Muted.Render("┌─ STEP 2: CONFIGURE PROVIDERS ──────────────────────────────────────────┐"),
		"",
	}

	opts := providerOptions()
	if m.mode == modeA {
		lines = append(lines, m.th.Accent.Render("Mode A: Delegator + Executor"))
		lines = append(lines, renderProviderList(m.th, "Delegator", opts, m.providerSelectedA, m.providerFocus == 0))
		lines = append(lines, renderProviderList(m.th, "Executor", opts, m.providerSelectedB, m.providerFocus == 1))
		lines = append(lines, m.th.Muted.Render("[Tab] Switch slot    [Up/Down] Select    [Enter] Continue    [Esc] Back"))
	} else {
		lines = append(lines, m.th.Accent.Render("Mode B: Single session"))
		lines = append(lines, renderProviderList(m.th, "Provider", opts, m.providerSelected, true))
		lines = append(lines, m.th.Muted.Render("[Up/Down] Select    [Enter] Continue    [Esc] Back"))
	}

	body := strings.Join(lines, "\n")
	frame := m.th.Frame
	if w, _ := m.effectiveSize(); w >= 4 {
		frame = frame.Width(w - 2)
	}
	return frame.Render(header + "\n" + body)
}

func (m appModel) viewCockpit() string {
	header := renderHeader(m.th, m.cfg.applicationV, m.mcpConnected, m.sessionID)

	w, h := m.effectiveSize()
	// Cockpit uses a 2-panel layout; on narrow terminals, stack vertically to avoid wrap jitter.
	if w < 35 || h < 10 {
		return m.viewTooSmall(w, h)
	}

	if w < 70 {
		left := m.viewChatLeft(w)
		right := m.viewStatusRight(w)
		base := lipgloss.JoinVertical(lipgloss.Top, header, left, "", right)
		switch m.currentOverlay() {
		case overlayCommandPalette:
			return renderOverlay(m.th, base, m.viewCommandPalette())
		case overlayModelSelect:
			return renderOverlay(m.th, base, m.viewModelSelect())
		case overlayQuickActions:
			return renderOverlay(m.th, base, m.viewQuickActions())
		case overlayQuitConfirm:
			return renderOverlay(m.th, base, m.viewQuitConfirm())
		case overlayAuthSelect:
			return renderOverlay(m.th, base, m.viewAuthSelect())
		case overlayStats:
			return renderOverlay(m.th, base, m.viewStats())
		case overlaySystemInfo:
			return renderOverlay(m.th, base, m.viewSystemInfo())
		case overlayProviderSelect:
			return renderOverlay(m.th, base, m.viewProviderSelect())
		case overlayRuntimeSelect:
			return renderOverlay(m.th, base, m.viewRuntimeSelect())
		}
		return base
	}

	leftW := clamp(int(float64(w)*0.70), 24, w-24-1)
	rightW := max(24, w-leftW-1)

	left := m.viewChatLeft(leftW)
	right := m.viewStatusRight(rightW)

	row := lipgloss.JoinHorizontal(lipgloss.Top, left, m.th.Muted.Render("│"), right)
	base := lipgloss.JoinVertical(lipgloss.Top, header, row)

	switch m.currentOverlay() {
	case overlayCommandPalette:
		return renderOverlay(m.th, base, m.viewCommandPalette())
	case overlayModelSelect:
		return renderOverlay(m.th, base, m.viewModelSelect())
	case overlayQuickActions:
		return renderOverlay(m.th, base, m.viewQuickActions())
	case overlayQuitConfirm:
		return renderOverlay(m.th, base, m.viewQuitConfirm())
	case overlayAuthSelect:
		return renderOverlay(m.th, base, m.viewAuthSelect())
	case overlayStats:
		return renderOverlay(m.th, base, m.viewStats())
	case overlaySystemInfo:
		return renderOverlay(m.th, base, m.viewSystemInfo())
	case overlayProviderSelect:
		return renderOverlay(m.th, base, m.viewProviderSelect())
	case overlayRuntimeSelect:
		return renderOverlay(m.th, base, m.viewRuntimeSelect())
	}
	return base
}

func (m appModel) viewChatLeft(width int) string {
	lines := []string{}
	for _, e := range m.chatRoleLines {
		switch e.Role {
		case "user":
			lines = append(lines, m.th.Accent.Render("You: ")+e.Text)
		case "assistant":
			lines = append(lines, m.th.Success.Render("AI: ")+e.Text)
		default:
			lines = append(lines, m.th.Muted.Render("[SYSTEM] ")+e.Text)
		}
	}
	if m.chatInFlight {
		if strings.TrimSpace(m.chatStreamText) != "" {
			stream := strings.ReplaceAll(m.chatStreamText, "\n", " ")
			stream = strings.TrimSpace(stream)
			if len(stream) > 240 {
				stream = stream[len(stream)-240:]
			}
			lines = append(lines, m.th.Success.Render("AI: ")+stream)
		}
		lines = append(lines, m.th.Muted.Render("AI is working "+spinner(m.now)))
	}
	if len(lines) > 14 {
		lines = lines[len(lines)-14:]
	}
	history := strings.Join(lines, "\n")

	inputLine := "> " + m.th.Input.Render(m.input)

	footer := m.th.Muted.Render("[Enter] Quick Menu    [/] Cmd Palette")
	panel := m.th.Panel.Width(width - 2).Render(history + "\n\n" + inputLine + "\n" + footer)
	return panel
}

func spinner(now time.Time) string {
	frames := []string{"|", "/", "-", "\\"}
	i := int(now.UnixMilli()/120) % len(frames)
	return frames[i]
}

func extractCwdFromPrompt(text string) string {
	s := strings.TrimSpace(text)
	if s == "" {
		return ""
	}

	ls := strings.ToLower(s)
	markers := []string{
		`\\wsl.localhost\ubuntu\`,
		`\\wsl.localhost\\ubuntu\\`,
	}
	for _, marker := range markers {
		if idx := strings.Index(ls, marker); idx >= 0 {
			rest := s[idx+len(marker):]
			rest = strings.ReplaceAll(rest, `\\`, `/`)
			rest = strings.ReplaceAll(rest, `\`, `/`)
			rest = strings.TrimSpace(rest)
			if rest != "" && !strings.HasPrefix(rest, "/") {
				rest = "/" + rest
			}
			return rest
		}
	}

	// Best-effort: find the first token that looks like an absolute unix path.
	for _, tok := range strings.Fields(s) {
		t := strings.Trim(tok, "\"'`.,;:()[]{}")
		if strings.HasPrefix(t, "/") {
			return t
		}
	}
	return ""
}

func (m appModel) viewStatusRight(width int) string {
	oauthBorder := lipgloss.Color("#7D7D7D")
	if !m.oauthFlashUntil.IsZero() && time.Now().Before(m.oauthFlashUntil) {
		oauthBorder = lipgloss.Color("#FFBF00")
	}

	oauthBox := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(oauthBorder).
		Padding(0, 1).
		Width(width - 2)

	compat := m.currentCompatibility()
	compatStr := "✓"
	if compat == compatProxy {
		compatStr = "⚠ proxy"
	}

	status := []string{
		m.th.Accent.Render("STATUS"),
		fmt.Sprintf("Mode:     %s", m.mode.String()),
		fmt.Sprintf("Provider: %s", m.selectedProviderLabel()),
		fmt.Sprintf("Runtime:  %s", m.selectedRuntimeLabel()),
		fmt.Sprintf("Compat:   %s", compatStr),
		fmt.Sprintf("Model:    %s", m.selectedModel),
		fmt.Sprintf("OAuth:    %s", nonEmpty(m.lastOAuthProfile, "unknown")),
		fmt.Sprintf("MCP:      %d connected", m.mcpConnected),
		"",
		m.th.Muted.Render("[ OAUTH POOL (Codex) ]"),
	}

	if len(m.oauthPool.Profiles) == 0 {
		status = append(status,
			"● (unknown) (Active)",
			renderProgress(m.th, 0.82, 10),
			"○ (unknown) (Standby)",
			renderProgress(m.th, 0.21, 10),
			"‼ (unknown) (Limited)",
			renderProgress(m.th, 1.00, 10),
		)
	} else {
		ordered := orderOAuthProfilesForDisplay(m.oauthPool.Profiles)
		maxShow := 3
		if len(ordered) < maxShow {
			maxShow = len(ordered)
		}
		for i := 0; i < maxShow; i++ {
			status = append(status, renderOAuthProfileBlockWithUsage(m.th, ordered[i], m.usageByProfile[ordered[i].Profile], m.now)...)
		}
	}

	status = append(status, "", m.th.Muted.Render("[ ALERTS ]"))

	recent := m.alerts
	if len(recent) > 6 {
		recent = recent[len(recent)-6:]
	}
	for _, a := range recent {
		line := fmt.Sprintf("[%s] %s", a.Severity, a.Message)
		switch a.Severity {
		case alertCritical:
			status = append(status, m.th.Danger.Render(line))
		case alertError:
			status = append(status, m.th.Danger.Render(line))
		case alertWarn:
			status = append(status, m.th.Alert.Render(line))
		default:
			status = append(status, m.th.Muted.Render(line))
		}
	}

	return oauthBox.Render(strings.Join(status, "\n"))
}

func (m appModel) viewCommandPalette() string {
	items := filteredCommandPaletteItems(m.commandPaletteNamespace, m.commandPaletteQuery)
	ns := m.commandPaletteNamespace
	if ns != "//" {
		ns = "/"
	}
	lines := []string{
		m.th.Accent.Render(ns + " COMMAND PALETTE"),
		m.th.Muted.Render("> " + ns + m.commandPaletteQuery),
	}
	for i, it := range items {
		prefix := "  "
		label := fmt.Sprintf("%s%s", ns, it.cmd)
		desc := it.desc
		row := fmt.Sprintf("%-10s %s", label, desc)
		if i == m.commandPaletteIndex {
			prefix = m.th.Accent.Render("> ")
			row = m.th.Accent.Render(row)
		}
		lines = append(lines, prefix+row)
	}
	return m.th.OverlayBox.Render(strings.Join(lines, "\n"))
}

func (m appModel) viewModelSelect() string {
	items := modelOptions()
	lines := []string{
		m.th.Accent.Render("MODEL SELECT"),
		m.th.Muted.Render("Esc: back    Enter: apply"),
	}
	for i, it := range items {
		prefix := "  "
		text := it
		if i == m.modelSelectIndex {
			prefix = m.th.Accent.Render("> ")
			text = m.th.Accent.Render(it)
		}
		lines = append(lines, prefix+text)
	}
	return m.th.OverlayBox.Render(strings.Join(lines, "\n"))
}

func (m appModel) viewProviderSelect() string {
	opts := providerOptions()
	lines := []string{
		m.th.Accent.Render("//provider  LLM PROVIDERS"),
		m.th.Muted.Render("Esc: back    Enter: select"),
		m.th.Muted.Render("Current runtime: " + m.selectedRuntimeLabel()),
		"",
	}
	for i, p := range opts {
		prefix := "  "
		compat := getCompatibility(p, m.selectedRuntime)
		compatLabel := "✓"
		if compat == compatProxy {
			compatLabel = "⚠ proxy"
		}
		row := fmt.Sprintf("%-20s %s", p, compatLabel)
		if p == m.selectedProvider {
			row = row + " (current)"
		}
		if i == m.providerSelectIndex {
			prefix = m.th.Accent.Render("> ")
			row = m.th.Accent.Render(row)
		}
		lines = append(lines, prefix+row)
	}
	return m.th.OverlayBox.Render(strings.Join(lines, "\n"))
}

func (m appModel) viewRuntimeSelect() string {
	unified := runtimeOptionsUnified()
	lines := []string{
		m.th.Accent.Render("//runtime  RUNTIMES"),
		m.th.Muted.Render("Esc: back    Enter: select"),
		m.th.Muted.Render("Provider: " + m.selectedProviderLabel()),
		"",
	}
	for i, r := range unified {
		prefix := "  "
		compat := getCompatibility(m.selectedProvider, r.ID)
		compatLabel := "✓"
		if compat == compatProxy {
			compatLabel = "⚠ proxy"
		}
		row := fmt.Sprintf("%-22s %s", r.Label, compatLabel)
		if r.ID == m.selectedRuntime {
			row = row + " (current)"
		}
		if i == m.runtimeSelectIndex {
			prefix = m.th.Accent.Render("> ")
			row = m.th.Accent.Render(row)
		}
		lines = append(lines, prefix+row)
	}
	lines = append(lines, "", m.th.Muted.Render("Compatibility matrix:"))
	lines = append(lines, m.th.Muted.Render("✓ Native = works directly"))
	lines = append(lines, m.th.Muted.Render("⚠ Proxy = requires proxy setup"))
	return m.th.OverlayBox.Render(strings.Join(lines, "\n"))
}

func (m appModel) viewQuickActions() string {
	items := quickActionItems()
	lines := []string{
		m.th.Accent.Render("QUICK ACTIONS"),
	}
	for i, it := range items {
		prefix := "  "
		line := it
		if i == m.quickActionsIndex {
			prefix = m.th.Accent.Render("> ")
			line = m.th.Accent.Render(line)
		}
		lines = append(lines, prefix+line)
	}
	return m.th.OverlayBox.Render(strings.Join(lines, "\n"))
}

func (m appModel) viewQuitConfirm() string {
	lines := []string{
		m.th.Danger.Render("QUIT WORKBENCH?"),
		m.th.Muted.Render("Enter/y: quit    Esc/n: cancel"),
	}
	return m.th.OverlayBox.Render(strings.Join(lines, "\n"))
}

func (m appModel) viewAuthSelect() string {
	profiles := orderOAuthProfilesForDisplay(m.oauthPool.Profiles)
	lines := []string{
		m.th.Accent.Render("//auth  OAUTH ACCOUNTS"),
		m.th.Muted.Render("Esc: back    Enter: select"),
	}
	for i, p := range profiles {
		prefix := "  "
		row := fmt.Sprintf("%s (%s)", p.Email, strings.ToLower(p.Status))
		if i == m.authSelectIndex {
			prefix = m.th.Accent.Render("> ")
			row = m.th.Accent.Render(row)
		}
		lines = append(lines, prefix+row)
	}
	return m.th.OverlayBox.Render(strings.Join(lines, "\n"))
}

func (m appModel) viewStats() string {
	lines := []string{
		m.th.Accent.Render("//stats  SESSION"),
		m.th.Muted.Render("Enter/Esc: close"),
		"",
		fmt.Sprintf("Session: %s", m.sessionID),
		fmt.Sprintf("Mode:    %s", m.mode.String()),
		fmt.Sprintf("Model:   %s", m.selectedModel),
		fmt.Sprintf("MCP:     %d connected", m.mcpConnected),
		fmt.Sprintf("OAuth:   %s", nonEmpty(m.lastOAuthProfile, "unknown")),
		"",
		m.th.Muted.Render("[ Recent Commands ]"),
	}
	cmds := m.recentCommands
	if len(cmds) == 0 {
		lines = append(lines, m.th.Muted.Render("(none)"))
	} else {
		for _, c := range cmds {
			lines = append(lines, m.th.Muted.Render(c))
		}
	}
	return m.th.OverlayBox.Render(strings.Join(lines, "\n"))
}

func (m appModel) viewSystemInfo() string {
	exec := "unknown"
	if m.systemExecutorReady {
		exec = "ready"
	} else if isSystemExecutorReady(m.cfg.stateDir, m.sessionID, m.now) {
		exec = "ready"
	}

	codexExec := "unknown"
	if m.codexExecutorReady {
		codexExec = "ready"
	} else if isCodexExecutorReady(m.cfg.stateDir, m.sessionID, m.now) {
		codexExec = "ready"
	}

	opencodeExec := "unknown"
	if m.opencodeExecutorReady {
		opencodeExec = "ready"
	} else if isOpencodeExecutorReady(m.cfg.stateDir, m.sessionID, m.now) {
		opencodeExec = "ready"
	}

	lines := []string{
		m.th.Accent.Render("// SYSTEM"),
		m.th.Muted.Render("Enter/Esc: close"),
		"",
		fmt.Sprintf("System executor: %s", exec),
		fmt.Sprintf("Codex executor:  %s", codexExec),
		fmt.Sprintf("OpenCode exec:   %s", opencodeExec),
		fmt.Sprintf("Thought stream:  %v", m.thoughtStream),
		fmt.Sprintf("In flight:       %v", m.systemInFlight),
		"",
	}

	if m.systemLastResult != nil {
		lines = append(lines,
			m.th.Muted.Render("[ Last Result ]"),
			fmt.Sprintf("Action:  %s", nonEmpty(m.systemLastResult.Action, "?")),
			fmt.Sprintf("Status:  %v", m.systemLastResult.Ok),
			fmt.Sprintf("Summary: %s", nonEmpty(m.systemLastResult.Summary, "(none)")),
		)
		if strings.TrimSpace(m.systemLastResult.Detail) != "" {
			lines = append(lines, "", m.th.Muted.Render("[ Detail ]"), strings.TrimSpace(m.systemLastResult.Detail))
		}
	} else {
		lines = append(lines, m.th.Muted.Render("(no system results yet)"))
	}

	lines = append(lines,
		"",
		m.th.Muted.Render("CLI parity:"),
		m.th.Muted.Render("- workbench verify --full"),
		m.th.Muted.Render("- workbench dev start --mode B --json"),
	)
	return m.th.OverlayBox.Render(strings.Join(lines, "\n"))
}

type paletteItem struct {
	cmd    string
	desc   string
	label  string
	action string
}

func commandPaletteItems() []paletteItem {
	return []paletteItem{
		{cmd: "clear", desc: "Clear Context Window", label: "Clear Context Window", action: "clear"},
	}
}

func systemCommandPaletteItems() []paletteItem {
	return []paletteItem{
		{cmd: "provider", desc: "Switch LLM Provider (OpenAI/Anthropic/Google/Ollama)", label: "Switch LLM Provider", action: "provider"},
		{cmd: "runtime", desc: "Switch Runtime (Codex Chat/CLI, Claude Code, Direct API)", label: "Switch Runtime", action: "runtime"},
		{cmd: "model", desc: "Switch AI Model", label: "Switch AI Model", action: "model"},
		{cmd: "auth", desc: "Manage OAuth Accounts", label: "Manage OAuth Accounts", action: "auth"},
		{cmd: "mode", desc: "Switch Session Mode (A <-> B)", label: "Switch Session Mode", action: "mode"},
		{cmd: "stats", desc: "View Detailed Statistics", label: "View Detailed Statistics", action: "stats"},
		{cmd: "docker", desc: "Docker status/probe", label: "Docker status/probe", action: "docker"},
		{cmd: "verify", desc: "Run verification gates", label: "Run verification gates", action: "verify"},
		{cmd: "exit", desc: "Close Session", label: "Close Session", action: "exit"},
	}
}

func filteredCommandPaletteItems(namespace string, query string) []paletteItem {
	items := commandPaletteItems()
	if namespace == "//" {
		items = systemCommandPaletteItems()
	}
	q := strings.TrimSpace(strings.ToLower(query))
	if q == "" {
		return items
	}
	type scored struct {
		it    paletteItem
		score int
		idx   int
	}
	matches := make([]scored, 0, len(items))
	for i, it := range items {
		cmd := strings.ToLower(it.cmd)
		desc := strings.ToLower(it.desc)
		score := -1
		if strings.HasPrefix(cmd, q) {
			score = 0
		} else if strings.Contains(cmd, q) {
			score = 1
		} else if strings.Contains(desc, q) {
			score = 2
		}
		if score >= 0 {
			matches = append(matches, scored{it: it, score: score, idx: i})
		}
	}
	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].score != matches[j].score {
			return matches[i].score < matches[j].score
		}
		return matches[i].idx < matches[j].idx
	})
	out := make([]paletteItem, 0, len(matches))
	for _, m := range matches {
		out = append(out, m.it)
	}
	return out
}

func quickActionItems() []string {
	return []string{"Switch Provider", "Switch Runtime", "Change Mode", "Toggle Thought Stream", "Snapshot Evidence"}
}

// Provider selection - LLM vendor
func providerOptions() []string {
	return []string{
		"OpenAI",
		"Anthropic",
		"Google (Gemini)",
		"Ollama (local)",
	}
}

// Runtime selection - unified runtime + mode
type unifiedRuntime struct {
	ID          string
	Label       string
	Description string
}

func runtimeOptionsUnified() []unifiedRuntime {
	return []unifiedRuntime{
		{ID: "codex-chat", Label: "Codex – Chat Mode", Description: "OpenAI API, chat-only interface"},
		{ID: "codex-cli", Label: "Codex – CLI Mode", Description: "OpenAI with Codex CLI, full code editing with file access"},
		{ID: "opencode-run", Label: "OpenCode – Run Mode", Description: "OpenCode headless runner (streams tool/step events)"},
		{ID: "claude-code", Label: "Claude Code", Description: "Anthropic native TTY, full capabilities (code editing, tools)"},
		{ID: "direct-api", Label: "Direct API", Description: "Any provider, chat-only interface"},
	}
}

// Compatibility types
type compatibilityType int

const (
	compatNative compatibilityType = iota // Works directly
	compatProxy                            // Needs proxy setup
)

func (c compatibilityType) String() string {
	switch c {
	case compatNative:
		return "native"
	case compatProxy:
		return "proxy"
	default:
		return "unknown"
	}
}

// Check if combination needs proxy (configurable)
func getCompatibility(provider, runtime string) compatibilityType {
	p := strings.ToLower(strings.TrimSpace(provider))
	r := strings.ToLower(strings.TrimSpace(runtime))

	switch {
	case strings.Contains(r, "opencode"):
		return compatNative
	case strings.Contains(r, "claude"):
		if strings.Contains(p, "anthropic") {
			return compatNative
		}
		return compatProxy
	case strings.Contains(r, "codex"):
		if strings.Contains(p, "openai") {
			return compatNative
		}
		return compatProxy
	case strings.Contains(r, "direct"):
		return compatNative // All providers work directly
	}
	return compatProxy
}

func getCompatibilityLabel(provider, runtime string) string {
	compat := getCompatibility(provider, runtime)
	if compat == compatNative {
		return "✓ Native"
	}
	return "⚠ Proxy required"
}

func (m appModel) selectedProviderLabel() string {
	if strings.TrimSpace(m.selectedProvider) != "" {
		return m.selectedProvider
	}
	// Fallback to index-based selection for Mode A
	opts := providerOptions()
	if len(opts) == 0 {
		return "unknown"
	}
	if m.mode == modeA {
		// For now, show the focused slot to avoid ambiguity in the single status line.
		if m.providerFocus == 0 {
			return opts[clamp(m.providerSelectedA, 0, len(opts)-1)]
		}
		return opts[clamp(m.providerSelectedB, 0, len(opts)-1)]
	}
	return opts[clamp(m.providerSelected, 0, len(opts)-1)]
}

func (m appModel) selectedRuntimeLabel() string {
	if strings.TrimSpace(m.selectedRuntime) == "" {
		return "direct-api"
	}
	for _, r := range runtimeOptionsUnified() {
		if r.ID == m.selectedRuntime {
			return r.Label
		}
	}
	return m.selectedRuntime
}

func (m appModel) currentCompatibility() compatibilityType {
	return getCompatibility(m.selectedProvider, m.selectedRuntime)
}

func modelOptions() []string {
	return []string{
		"gpt-5.2",
		"gpt-5.2-high",
		"gpt-5.1",
		"gpt-5.1-codex",
	}
}

func renderHeader(th theme, version string, mcpConnected int, sessionID string) string {
	left := fmt.Sprintf("WORKBENCH SHELL %s", version)
	right := fmt.Sprintf("[ MCP: %d Connected ]", mcpConnected)
	line := fmt.Sprintf("%s %s", left, right)
	return th.Header.Render(line) + "\n" + th.Muted.Render(fmt.Sprintf("Session: %s", sessionID))
}

func renderProviderList(th theme, title string, options []string, selected int, focused bool) string {
	lines := []string{th.Muted.Render(title + ":")}
	for i, opt := range options {
		prefix := "  "
		text := opt
		if i == selected && focused {
			prefix = th.Accent.Render("> ")
			text = th.Accent.Render(opt)
		} else if i == selected {
			prefix = "• "
		}
		lines = append(lines, prefix+text)
	}
	return strings.Join(lines, "\n")
}

func renderOverlay(th theme, base string, overlay string) string {
	dim := th.Overlay.Render(base)
	return dim + "\n\n" + overlay
}

func renderProgress(th theme, ratio float64, width int) string {
	if ratio < 0 {
		ratio = 0
	}
	if ratio > 1 {
		ratio = 1
	}
	filled := int(ratio * float64(width))
	if filled > width {
		filled = width
	}
	bar := strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
	return th.Muted.Render("  [" + bar + fmt.Sprintf("] %d%%", int(ratio*100)))
}

func (m appModel) effectiveSize() (int, int) {
	w := m.width
	h := m.height
	// Bubble Tea smoke tests and headless runs may not deliver a WindowSizeMsg; assume a sane default.
	if w <= 0 {
		w = 80
	}
	if h <= 0 {
		h = 24
	}
	return w, h
}

func (m appModel) viewTooSmall(w, h int) string {
	lines := []string{
		m.th.Header.Render("WORKBENCH"),
		m.th.Alert.Render("Terminal too small"),
		m.th.Muted.Render(fmt.Sprintf("Minimum: 20x6 (cockpit: 35x10). Current: %dx%d", w, h)),
		m.th.Muted.Render("Tip: resize the terminal window."),
	}
	return strings.Join(lines, "\n")
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func nonEmpty(v string, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

func orderOAuthProfilesForDisplay(profiles []oauthPoolProfile) []oauthPoolProfile {
	out := append([]oauthPoolProfile{}, profiles...)
	rank := func(status string) int {
		switch status {
		case "ACTIVE":
			return 0
		case "STANDBY":
			return 1
		case "LIMITED":
			return 2
		default:
			return 3
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		ai := out[i]
		aj := out[j]
		if rank(ai.Status) != rank(aj.Status) {
			return rank(ai.Status) < rank(aj.Status)
		}
		return ai.Email < aj.Email
	})
	return out
}

func renderOAuthProfileBlockWithUsage(th theme, p oauthPoolProfile, usage *usageData, now time.Time) []string {
	bullet := "○"
	switch p.Status {
	case "ACTIVE":
		bullet = "●"
	case "LIMITED":
		bullet = "‼"
	}
	label := fmt.Sprintf("%s %s (%s)", bullet, p.Email, strings.ToLower(p.Status))
	lines := []string{label}

	if usage != nil && len(usage.Windows) > 0 {
		for _, kind := range []string{"5h", "weekly"} {
			w, ok := findUsageWindow(usage, kind)
			if !ok {
				continue
			}
			reset := formatResetUntil(now, w.ResetAtMs)
			pct := clampFloat(w.Percent, 0, 100)
			lines = append(lines, fmt.Sprintf("  %s Used: %.0f%% Reset:%s", kind, pct, reset))
			lines = append(lines, "  "+renderProgressPlain(pct/100.0, 10))
		}
	} else {
		lines = append(lines, "  5h Used: ? Reset:?")
		lines = append(lines, "  "+renderProgressPlain(0, 10))
	}

	style := th.Muted
	switch p.Status {
	case "LIMITED":
		style = th.Alert
	case "ACTIVE":
		style = th.Success
	}

	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, style.Render(l))
	}
	return out
}

func findUsageWindow(u *usageData, typ string) (usageWindow, bool) {
	if u == nil {
		return usageWindow{}, false
	}
	for _, w := range u.Windows {
		if strings.TrimSpace(strings.ToLower(w.Type)) == strings.TrimSpace(strings.ToLower(typ)) {
			return w, true
		}
	}
	return usageWindow{}, false
}

func clampFloat(v float64, lo float64, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func formatResetUntil(now time.Time, resetAtMs int64) string {
	if resetAtMs <= 0 {
		return "?"
	}
	resetAt := time.UnixMilli(resetAtMs)
	d := resetAt.Sub(now)
	if d < 0 {
		d = 0
	}
	if d >= 24*time.Hour {
		days := int(d / (24 * time.Hour))
		hours := int((d % (24 * time.Hour)) / time.Hour)
		return fmt.Sprintf("%dd%dh", days, hours)
	}
	return d.Truncate(time.Second).String()
}

func renderProgressPlain(ratio float64, width int) string {
	if ratio < 0 {
		ratio = 0
	}
	if ratio > 1 {
		ratio = 1
	}
	filled := int(ratio * float64(width))
	if filled > width {
		filled = width
	}
	bar := strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
	return "[" + bar + fmt.Sprintf("] %d%%", int(ratio*100))
}

func codexModelForSelection(selected string) string {
	s := strings.TrimSpace(selected)
	ls := strings.ToLower(s)
	if s == "" {
		return "gpt-5.2-codex"
	}
	if strings.Contains(ls, "codex") {
		return s
	}
	if strings.HasSuffix(ls, "-high") {
		base := strings.TrimSuffix(s, s[len(s)-5:])
		base = strings.TrimSuffix(base, "-")
		if base == "" {
			return s + "-codex"
		}
		return base + "-codex-high"
	}
	return s + "-codex"
}
