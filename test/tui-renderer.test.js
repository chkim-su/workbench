import test from "node:test"
import assert from "node:assert/strict"

import { TuiState } from "../ui/tui/state.js"
import { render } from "../ui/tui/renderer.js"

function stripAnsi(input) {
  if (!input) return ""
  // Good-enough ANSI escape stripper for our renderer output (CSI sequences).
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

test("tui renderer never emits lines wider than cols", () => {
  const state = new TuiState()
  state.mode = "menu"

  const cols = 32
  const rows = 12
  const out = render(state, { cols, rows })

  assert.ok(!out.includes("\x1b[2J"), "renderer should not full-clear the screen")

  const visibleLines = stripAnsi(out).split("\n")
  for (const line of visibleLines) {
    assert.ok(line.length <= cols, `line exceeds cols: ${line.length} > ${cols}`)
  }
})

test("tui renderer respects rows guard for tiny terminals", () => {
  const state = new TuiState()
  state.mode = "menu"

  const cols = 10
  const rows = 4
  const out = render(state, { cols, rows })
  const visibleLines = stripAnsi(out).split("\n")

  assert.ok(visibleLines.length <= rows, `output exceeds rows: ${visibleLines.length} > ${rows}`)
  for (const line of visibleLines) {
    assert.ok(line.length <= cols, `line exceeds cols: ${line.length} > ${cols}`)
  }
})

