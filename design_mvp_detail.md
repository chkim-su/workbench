# Project Spec Handoff — My LLM Workbench TUI/UX (Commercial-Grade)

Target: Go (Bubble Tea) + Lip Gloss

You are the project-management LLM for this repository. Convert the following UI/UX Design Specification into an implementable, testable, minimal-diff plan. Treat the spec below as authoritative. Do not propose alternative UX patterns or expand scope.

## 0) Scope Framing and Mode Intent

We are building both Mode A and Mode B. Mode A is the larger end-goal, but we intentionally build Mode B first as the reusable foundation.

Mode B is a normal LLM session with optional Workbench capabilities (Docker testbed, workflow feature, verification, durable evidence). It is not “controlled protocol.”
Mode A adds the controlled protocol (Delegator/Executor split, user-triggered freeze, phase-by-phase review).

This spec focuses on the **TUI/UX product layer** only (Bubble Tea + Lip Gloss). It must integrate cleanly with the repo’s “MCP-first control interface” direction and keep verification reproducible. Do not redesign provider/runner semantics.

## 1) Success Criteria (What “Done” Means)

A working TUI skeleton that provides:

1. Launcher dashboard on `workbench` start: shows MCP connection count and session id, and allows Mode selection (A/B).
2. Provider configuration screen after mode selection: Mode A dual-slot (Delegator + Executor), Mode B single-slot. Keyboard-only navigation.
3. Main session cockpit: 70/30 split, chat/log left, dense status right.
4. Overlays: `/` opens command palette modal with dimmed background; empty input + Enter opens quick actions popup near input.
5. Styling implemented per Lip Gloss theme (borders, palette, progress bars, alert/danger cues, OAuth swap flash).
6. Reproducible verification: at least one real-test gate (prefer Docker harness) that proves launcher renders, mode selection works, overlays invoke, and durable artifacts are produced under `.workbench/`.

“Compiles” or “imports” is not verification.

## 2) Change Boundaries (Hard Constraints)

Allowed changes: UI/TUI code under `ui/`, minimal glue for entrypoints, docs that describe entrypoints, verification entrypoints that exercise the TUI (prefer MCP-first orchestration), `.mcp.json` only if needed to run verification cleanly.

Not allowed (unless explicitly requested later): major UI redesign beyond this spec, provider/runner behavior changes, Docker images/compose beyond what is needed for verification harness, broad refactors unrelated to TUI integration.

## 3) Architectural Non-Negotiables

Apply SRP/OCP/DIP: keep rendering pure; isolate domain/state from rendering; isolate IO/adapters.
Avoid duplicate entrypoints: one canonical TUI entrypoint.
Avoid CLI-first verification: prefer MCP-first orchestration for gates and durable evidence.
Durable artifacts must land under `.workbench/` (or the repo’s defined durable artifacts root).
Do not introduce new features not listed in this spec.

## 4) Required Output Format (What You Must Produce)

Produce three deliverables:

A) A phased plan (Phase 0..N). For each phase: exact files to create/modify, acceptance criteria, and a real-test gate that must pass before proceeding.
B) A minimal Bubble Tea component map: model/update/view boundaries, overlay architecture, where provider selection state lives, where session metrics come from.
C) A reproducible verification strategy (prefer Docker) including commands to run, expected durable artifacts, and explicit pass/fail conditions.

Ask follow-up questions only if a missing detail blocks correctness or verification. No broad “options” discussion.

---

# 5) Authoritative UI/UX Design Specification (Implement As-Is)

Framework targets: Go + Bubble Tea + Lip Gloss.

## 5.1 Screen 1-1 — Launcher Dashboard (Entry)

Behavior:

* Trigger: user runs `workbench` in WSL terminal.
* Header immediately shows MCP connection count and session id.
* User selects Mode A or Mode B.
* Keys: Up/Down navigate, Enter confirm, q quit.

Design example (ASCII reference):

```text
┌ WORKBENCH SHELL v1.0.0 ──────────────────────────────── [ MCP: 8 Connected ] ┐
│                                                                              │
│  TARGET SYSTEM: WSL2 (Ubuntu)                                                │
│  SESSION ID:    sess_9f8a2d                                                  │
│                                                                              │
│  ┌─ STEP 1: SELECT OPERATION MODE ────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │ > [A] CONTROLLED MODE                                                  │  │
│  │       Roles: Delegator (Plan) + Executor (Do)                          │  │
│  │       Focus: Closure Protocol, High Reliability                        │  │
│  │                                                                        │  │
│  │   [B] COMPATIBILITY MODE                                               │  │
│  │       Roles: Single Agent                                              │  │
│  │       Focus: Flexibility, Speed                                        │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  [↑/↓] Navigate   [Enter] Confirm   [q] Quit                                 │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 5.2 Screen 1-2 — Provider Configuration

Behavior:

* Trigger: immediately after mode selection.
* Mode A: show dual-slot configuration (Delegator + Executor).
* Mode B: show single-slot configuration (one agent).
* Keys: Up/Down select, Enter confirm/launch, Esc back. (Tab may be used for slot switching if implemented.)

Mode A design example (ASCII reference):

```text
┌ WORKBENCH SHELL v1.0.0 ──────────────────────────────── [ MCP: 8 Connected ] ┐
│                                                                              │
│  MODE: CONTROLLED (A)                                                        │
│                                                                              │
│  ┌─ STEP 2: CONFIGURE AGENT PAIR ─────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  1. DELEGATOR (The Brain)                                              │  │
│  │  [ ✔ Gemini 1.5 Pro ]                                                  │  │
│  │                                                                        │  │
│  │  2. EXECUTOR (The Hands)                                               │  │
│  │  > [ Claude Code (Raw TTY)     ]                                       │  │
│  │    [ Codex (Managed OAuth)     ]                                       │  │
│  │    [ Local Llama 3             ]                                       │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  [↑/↓] Select Provider   [Enter] Launch Session   [Esc] Back                 │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

Mode B behavior:

* Single agent slot with the same provider list, but without Delegator/Executor semantics.
* This mode is compatibility-first: it is not required to enforce controlled protocol.

## 5.3 Screen 2 — Main Session Cockpit (70/30 Split)

Behavior:

* Trigger: session launched.
* Left pane: chat/log stream (Managed sessions).
* Right pane: dense status panels:

  * Agent status (provider, latency)
  * Session metrics (uptime, cost, token output, files modified)
  * OAuth pool summary (Codex accounts, usage bars, remaining, reset)
* Input line at bottom; `/` opens command palette overlay.
* Empty input + Enter opens quick actions popup near input.

Design example (ASCII reference):

```text
┌─ WORKBENCH | Mode A (Active) ─────────────┐┌─ SYSTEM STATUS ─────────────────┐
│                                           ││                                 │
│ [Delegator]                               ││ [ AGENT STATUS ]                │
│ 사용자님, 현재 dental_crown 프로젝트의    ││ ● Delegator: Gemini 1.5 Pro     │
│ 데이터 포맷 불일치 문제를 해결하기 위해   ││   └ Latency: 450ms              │
│ 아래와 같은 전략을 제안합니다.            ││ ● Executor:  Codex (OAuth)      │
│                                           ││   └ Latency: 120ms              │
│ 1. .stl 파일 헤더 파싱 로직 수정          ││                                 │
│ 2. Mesh 데이터 정규화 스크립트 작성       ││ ─────────────────────────────── │
│                                           ││                                 │
│ 승인하시겠습니까?                         ││ [ SESSION METRICS ]             │
│                                           ││ Uptime:  00:14:22               │
│ [Executor]                                ││ Cost:    $0.042                 │
│ 대기 중입니다. 승인 시 바로 실행합니다.   ││ Tokens:  14,203 out             │
│                                           ││ Files:   3 modified             │
│                                           ││                                 │
│                                           ││ ─────────────────────────────── │
│ > _                                       ││                                 │
│                                           ││ [ OAUTH POOL (Codex) ]          │
│ [Enter] Quick Menu    [/] Cmd Palette     ││ ● User_01 (Active)              │
│                                           ││   [████████░░] 82%              │
│                                           ││   Rem: 1.8k                     │
│                                           ││ ○ User_02 (Standby)             │
│                                           ││   [██░░░░░░░░] 21%              │
│                                           ││   Rem: 7.9k                     │
│                                           ││ ‼ User_03 (Limited)             │
│                                           ││   [██████████] 100%             │
│                                           ││   Reset: 01:24:15               │
└───────────────────────────────────────────┘└─────────────────────────────────┘
```

## 5.4 Overlay UX (Keyboard-Only Control Plane)

### Screen 3 — Slash Command Palette (trigger: `/`)

* Floating modal centered in main view.
* Background dims.
* Filterable list.

Design example:

```text
┌───────────────────────────────────────────┐
│  / COMMAND PALETTE                        │
├───────────────────────────────────────────┤
│ > //model  Switch AI Model                │
│   //auth   Manage OAuth Accounts          │
│   //mode   Switch Session Mode (A <-> B)  │
│   //stats  View Detailed Statistics       │
│   /clear   Clear Context Window           │
│   //exit   Close Session                  │
└───────────────────────────────────────────┘
```

### Screen 4 — Quick Actions Selector (trigger: empty input + Enter)

* Small popup above the input line.
* Does not disrupt the session context.

Design example:

```text
│ ... (Chat History) ...                    │
│                                           │
│ ┌─ QUICK ACTIONS ──────────┐              │
│ │ > Switch Provider        │              │
│ │   Change Mode            │              │
│ │   Snapshot Evidence      │              │
│ └──────────────────────────┘              │
│ > _                                       │
└───────────────────────────────────────────┘
```

## 5.5 Lip Gloss Style Guide (Theme Rules)

Color palette (Professional Dark Theme):

* Primary (Accent): #00FFFF (Cyan) — selection, active status, header/border accents
* Secondary: #7D7D7D (Dark Gray) — inactive text, secondary borders
* Alert: #FFBF00 (Amber) — warnings, near rate-limit
* Danger: #FF0055 (Red) — errors, exceeded limits
* Success: #00FF00 (Green) — ready/healthy
* Background: terminal default (transparent / deep black)

Borders and layout:

* Main containers use `lipgloss.RoundedBorder()`
* Inner dividers use `lipgloss.NormalBorder()`
* Progress bar: full char `█`, empty char `░` with dimmed color

OAuth auto-swap animation:

* Trigger: when a Codex account hits limit and system swaps to next account.
* Effect: `[ OAUTH POOL ]` border flashes Amber for ~1 second, then returns to Gray.
* Additionally, append a system log line in the chat/log pane: `[SYSTEM] Swapped to User_02`.

---

# 6) Implementation Starting Point (Canonical Entry)

Start by implementing `ui/tui/app.go` as the Bubble Tea entrypoint that renders Screen 1-1 (Launcher Dashboard). From there, implement Screen 1-2, then Screen 2, then overlays.

You must produce a phased plan that ships the screens in the above order, with reproducible verification gates after each phase, writing evidence under `.workbench/`.

End of spec.
