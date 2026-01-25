# AGENTS.md — My LLM Workbench (Workbench)

This repository defines **My LLM Workbench** (formerly `csc`).  
Workbench is not “a chat UI.” It is a **command center** that lets a user choose an operational **strategy (Mode)** and an execution **toolchain (Provider + Auth + Surface)**, while enforcing **MCP-first control**, **durable evidence**, and **reproducible real tests**.

This document is not explanatory prose. It is a **behavior contract** for local code LLMs/agents (e.g., Codex, local models, agent runtimes). Agents must follow it. If an agent believes a rule must be violated, it must first explain why and propose a safer alternative.

---

## 0. Scope

This contract governs:

A. How agents modify the Workbench codebase (migration/refactor/integration work).  
B. How agents operate Workbench at runtime (LLM sessions, MCP tools, verification).  
C. How agents report progress and completion (evidence-driven, reproducible).

Out of scope:

A. “Product marketing” text, fluff, persuasion without evidence.  
B. UI rewrites that bypass the architectural invariants below.  
C. Bulk importing/copying from external repos unless explicitly approved and selectively scoped.

---

## 1. One-line Definition

**My LLM Workbench** is an environment that binds together:

(1) LLM session execution (provider selection, authentication, and surface/TTY),  
(2) controlled external operations via **MCP**,  
(3) verification harnesses (e.g., Docker), and  
(4) durable observability (logs/state/artifacts),

so that work remains **reproducible, auditable, and maintainable**.

---

## 2. Non-negotiable Hierarchy

### 2.1 MCP is the Control Plane (Not a Peer)

**MCP (Model Context Protocol)** is the **Control Plane**: the common mechanism to register, discover, operate, update, and query external services/environments.

Docker and Workflow are **not peers** of MCP:

(1) **Docker** is a **verification harness** (a test/run environment).  
(2) **Workflow** is an optional **feature layer** (progress, policy gates when enabled, standardization, observability).  
(3) **MCP** is the **control layer** that operates them and other external targets.

Agents must not add “direct side channels” that bypass MCP when MCP control is intended.

### 2.2 Default Path is MCP SDK-Based (CLI is not the default)

The normal/primary path must use **MCP SDK-based control**.

CLI-based control is excluded from the default path because it increases branching, bypasses validated control logic, and reduces reproducibility.

Allowed exceptions:

A. **Native TTY providers** (e.g., Claude Code) are inherently “external UI surfaces” and may require their own invocation.  
B. CLI usage may be used as an implementation detail **behind an MCP server**, if it is necessary and produces durable evidence.

### 2.3 State is Vendor-Neutral and Externalized

State must not be coupled to any single vendor’s private paths or assumptions (e.g., “Claude-only state”). Workbench is a larger system.

Agents must not treat model conversation context as durable state.  
Anything required for restart, audit, reproducibility, or diagnosis must be written to external storage (files/store) with schema/versioning.

---

## 3. Core Concepts and Definitions

### 3.1 “Mode” means Operational Strategy, not UI flavor

Mode is the user’s chosen operational strategy for running a session.

Mode affects:

A. Whether controlled closure/freeze/review policies are enforced.  
B. Whether a 2-role setup (Delegator + Executor) is used.  
C. What constraints exist on scope drift and phase review.

Mode does not mean:

A. “works vs barely works.”  
B. “rough mode.”  
Mode B is fully usable and professional; it is simply not a controlled process by default.

### 3.2 “Provider” means an LLM runtime + auth + surface contract

A provider is not just a model name. It is a runtime choice with:

A. authentication (OAuth, API key, etc.),  
B. surface type (native TTY vs managed session UI),  
C. tool-loop capability (MCP tool calling),  
D. evidence requirements (logging, redaction, repeatable verification).

### 3.3 “Surface” means where interaction happens

Workbench supports multiple surfaces:

A. **Launcher Surface**: Workbench startup command center (Mode/Provider selection).  
B. **Managed Surface**: Workbench-rendered session UI (for OAuth/API-managed providers like Codex/Gemini).  
C. **Native TTY Surface**: Raw external UI (e.g., Claude Code). Workbench must not “re-skin” or “mirror” it.

---

## 4. Session Modes (Final Definitions)

### 4.1 Mode A — Controlled Mode (Delegator + Executor)

Mode A embeds “our purpose”: long-horizon, high-trust work with explicit closure, stable contracts, phase review, and repeated real tests.

In Mode A:

A. A **Delegator** interacts with the user to progressively close the problem (Closure Protocol).  
B. **Freeze** happens **only when the user requests it** (never automatic).  
C. After Freeze, a stable execution contract exists; scope must not drift.  
D. An **Executor** performs the work under the frozen contract.  
E. Delegator review is required at the end of every phase (or defined checkpoint).  
F. **Real tests must be executed repeatedly throughout the run**, not only at the end.  
G. Evidence (logs/state/artifacts) is mandatory and must be durable.

Important correction:

Mode A requires **two LLM roles**, but it does **not** require a fixed “two tmux windows” topology. Workbench may run the two roles in any surface arrangement that preserves responsibility separation and durable evidence. tmux may be expanded if the user wants more panels, but the system must not hard-code “two panes” as a requirement.

### 4.2 Mode B — Compatibility Mode (General Session + Optional Workflow Feature)

Mode B is a general session mode with professional quality. It is not a controlled process by default.

In Mode B:

A. The user runs a standard LLM session.  
B. Workflow features (progress display, structuring helpers, evidence formatting, tool-use scaffolding) may be enabled optionally.  
C. Delegator/Executor split, Closure Protocol, user-triggered Freeze, and per-phase review are **not enforced by default**.  
D. If the user wants controlled behavior, they must choose Mode A.

Compatibility meaning:

Mode B exists so that users can use Workbench as a normal tool, and if they want Workbench workflow features, they get **full compatibility** with the same control plane (MCP), evidence layout, and verification entrypoints.

---

## 5. Launcher UX Contract (Command Center)

### 5.1 Workbench Launcher is not “a menu”; it is a command center

When the user runs:

`workbench`

Workbench must present a startup TUI that:

A. shows minimal but high-signal system status (version, session id, MCP connectivity, etc.),  
B. collects a **closed choice** of Mode and Provider setup,  
C. transitions to the correct surface based on Provider (native TTY vs managed session),  
D. does not begin “chatting” before Mode/Provider decisions are made.

### 5.2 Step-by-step selection (State-driven)

Workbench Launcher must be state-driven (Model-Update-View style).  
No “print event spam” rendering.

Required sequence:

Step 1. Select Mode (A or B).  
Step 2. Select Provider configuration.

Provider selection rules:

A. Mode B: select one provider (e.g., Claude Code, Codex, Gemini) and launch.  
B. Mode A: select a **Delegator provider** and an **Executor provider** (two roles).  
   The UI must make the two slots explicit.

Constraints:

A. Delegator and Executor must never collapse into “one role with two names.”  
B. The UI must not force tmux pane count. It only selects roles and surface types.

### 5.3 Runtime “Empty Submit” (Managed Surface)

In a managed session UI (Codex/Gemini), pressing Enter on empty input must not do nothing. It must open a **Quick Action Overlay** providing a closed set of operations:

A. Switch Mode (if allowed by policy; Mode A must not auto-unfreeze).  
B. Switch Provider (controlled transition, evidence recorded).  
C. Snapshot / Evidence capture.  
D. Close Problem (Mode A only; triggers closure protocol workflow).  
E. Exit session.

### 5.4 Slash “/” is a Command Surface (Managed Surface only)

In managed sessions, `/` opens a **command palette** (not textual slash commands).  
It must be a state transition, not a parser-first experience.

Examples of command surface categories:

A. Model selection  
B. Connection/profile selection  
C. OAuth account pool management (Codex)  
D. Tool visibility and MCP server status  
E. Verification triggers and evidence views

For native TTY surfaces (Claude Code), Workbench must not inject or redefine `/`.

---

## 6. Provider Contracts

### 6.1 Claude Code (Native TTY)

A. OAuth is not assumed; do not force OAuth UI for Claude Code.  
B. Workbench must treat Claude Code as a raw native TTY surface.  
C. Workbench may launch/focus the tmux target and record observability, but must not “re-skin” or attempt to mirror its UI.

### 6.2 Codex (OAuth Managed)

A. Codex is OAuth-managed and intended to support Workbench custom UX.  
B. Workbench must provide durable auth storage under Workbench-controlled paths (not vendor-only).  
C. Workbench may support multi-account OAuth pools and automatic account swap, but must make swaps transparent and evidence-backed.

### 6.3 Gemini (Managed by API/OAuth depending on configuration)

A. Gemini may be managed if supported by the chosen runtime.  
B. It must follow the same Workbench managed-surface UX principles: `/` palette, empty-submit overlay, evidence.

---

## 7. tmux: Optional Orchestration, Not the UI

### 7.1 tmux is an orchestration substrate

tmux provides:

A. session persistence (attach/detach),  
B. parallel process hosting,  
C. predictable terminal routing.

tmux is not the UI framework. The UI must remain state-driven (Bubble Tea, Ink, etc.) inside a pane if used.

### 7.2 Topology is flexible; do not hard-code pane counts

Workbench must support:

A. non-tmux (single terminal) execution when appropriate,  
B. tmux execution with user-configurable expansion.

A recommended baseline (not mandatory):

A. One pane: Workbench managed UI (launcher + managed sessions).  
B. Optional additional panes: native TTY provider surface, logs, verification output, workbench inspection.

Mode A does not require two tmux windows; it requires two roles and clear responsibility boundaries. Those boundaries may be satisfied by UI separation, structured logs/evidence separation, and policy enforcement.

---

## 8. Workflow (Optional Feature Layer)

Workflow in this project is not “pick an existing plan and run it.”

Workflow is an optional feature layer that can provide:

A. progress display and standardization,  
B. phase/policy gates when enabled,  
C. consistent evidence reporting,  
D. structured tool-use sequences.

Compatibility requirement:

Users may want workflow functionality only. The system must remain compatible with that use case without forcing controlled Mode A behavior.

---

## 9. Verification and “Real Tests” Policy

### 9.1 “Import succeeded” is not a real test

A real test executes meaningful behavior across boundaries and validates observable outcomes.

A real test must include at least one of:

A. exit codes and deterministic outputs,  
B. logs and artifacts stored durably,  
C. state transitions validated,  
D. service health checks / reachable endpoints.

### 9.2 Mode A: mid-run repeated gates are mandatory

In Mode A, verification is continuous and must be repeated:

A. after meaningful integration points,  
B. after refactors that touch control plane, runner, auth, or UI routing,  
C. before phase review.

Default harness is Docker-based verification if applicable; alternate harnesses must be justified as equivalent and must produce evidence.

### 9.3 Mode B: evidence-backed verification is required for claims

Mode B does not enforce controlled phase review, but agents must not claim “done” without running the relevant verification gates and producing evidence artifacts.

---

## 10. Evidence and Storage Contract

### 10.1 Durable artifact locations

Workbench must write durable evidence under a stable directory (example layout):

`.workbench/`

Within it, at minimum:

A. `.workbench/runs/<runId>/events.jsonl`  
B. `.workbench/runs/<runId>/summary.json`  
C. `.workbench/verify/gates/<verifyId>/summary.json`  
D. `.workbench/auth/...` (OAuth tokens, pools; must be redacted in logs)

The exact file names may evolve, but the invariants must hold:

A. append-only event logs for runs,  
B. summarized machine-readable status,  
C. reproducible verification summaries.

### 10.2 Redaction and secret handling

Agents must never print or persist raw secrets in logs or outputs.

Required behaviors:

A. redact bearer tokens and known secret env vars,  
B. store tokens only in designated auth stores,  
C. produce “provider doctor” info that reports configuration without secrets (baseUrl, model, auth present yes/no).

Agents must not ask users to paste API keys into chat. Only shell exports or local secret managers are acceptable.

---

## 11. MCP Servers and Registry

Workbench must maintain MCP-first control-plane behavior:

A. MCP servers must be runnable locally (stdio where possible).  
B. Discovery/registry must exist so tools can be listed and invoked deterministically.  
C. Verification must include MCP handshake and tool listing gates.

If a direct OS invocation is used, it must be behind an MCP server boundary and must still produce evidence.

---

## 12. Codebase Design Rules (General)

This repository is built for migration/refactor/integration. Agents must follow these design rules.

### 12.1 SOLID (Required)

SRP: one reason to change per unit; do not mix policy, execution, I/O, infra, UI.  
OCP: extend via additions; minimize modifications to stable code; do not over-abstract without a real change axis.  
LSP: substitutable implementations must preserve behavioral contracts; avoid “type-check branching” to special-case implementations.  
ISP: small, purpose-specific interfaces; no unused-method dependencies.  
DIP: high-level policy depends on abstractions; inject low-level implementations.

### 12.2 Additional engineering expectations

A. explicit dependency boundaries (control plane vs UI vs providers vs verification),  
B. minimal diffs, incremental migration,  
C. deterministic verification entrypoints,  
D. no hidden global state,  
E. schema/versioning for persisted state.

---

## 13. Agent Operating Rules (How to Work in This Repo)

### 13.1 Change boundaries are mandatory

Before modifying code, agents must declare:

A. what will be touched,  
B. what will not be touched,  
C. why this boundary is correct for the objective.

### 13.2 “Evidence over persuasion” policy

Agents must not claim completion without showing:

A. commands executed,  
B. observed outputs (summaries),  
C. paths to artifacts/logs.

### 13.3 No unbounded questioning

Especially in Mode A Delegator behavior:

A. The Delegator must progressively close the problem.  
B. The Delegator must not keep adding “just two more clarifying questions.”  
C. If information is missing, ask only what is necessary to close scope and move to Freeze when the user requests.

Freeze is user-triggered only; never automatic.

---

## 14. Reporting Format (Mandatory)

When reporting plans/progress/completion, agents must use this structure:

1. Restate the task and success criteria  
2. Declare change boundaries (what will and will not be touched)  
3. State the current mode and (if enabled) workflow context  
4. Describe changes and rationale (including SRP/OCP/etc. considerations)  
5. Provide real-test evidence (commands, environment, observed outcomes)  
6. List risks and mitigations  
7. Provide the next concrete actions (minimal, ordered, reproducible)

This repository values evidence and reproducibility.

---

## 15. Practical UX/Architecture Commitments (High Priority)

### 15.1 Launcher-first

Workbench must always start in Launcher mode, then transition to a surface.

### 15.2 Managed vs Native surfaces are explicitly different

Managed sessions get:

A. `/` command surface  
B. empty-submit overlay  
C. dashboard/side status views  
D. OAuth pool controls (if provider supports it)

Native TTY sessions do not.

### 15.3 State-driven rendering only

Whether using Bubble Tea (Go) or Ink (Node), UI must be state-driven.  
Avoid direct “print logs = UI” patterns.

---

## 16. Safety and Operational Constraints

A. Do not leak secrets.  
B. Do not run destructive commands unless explicitly requested and bounded.  
C. Prefer reversible changes and incremental refactors.  
D. If Docker access is required, verify daemon availability and permissions and record evidence; do not silently skip.

---

End of contract.
