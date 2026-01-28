import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readImageArtifact, readTextArtifact } from "../mcp/servers/workbench/src/artifacts.js"

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "workbench-artifacts-"))
}

test("readTextArtifact reads within baseDir and supports tailBytes", () => {
  const base = mkTmpDir()
  const stateDir = path.join(base, ".workbench")
  fs.mkdirSync(stateDir, { recursive: true })

  const p = path.join(stateDir, "logs.txt")
  fs.writeFileSync(p, "line1\nline2\nline3\n", "utf8")

  const full = readTextArtifact({ baseDir: stateDir, p })
  assert.equal(full.truncated, false)
  assert.match(full.text, /line2/)

  const tail = readTextArtifact({ baseDir: stateDir, p, tailBytes: 6 })
  assert.equal(tail.totalBytes, full.totalBytes)
  assert.ok(tail.bytes <= 6)
})

test("readTextArtifact rejects paths outside baseDir", () => {
  const base = mkTmpDir()
  const stateDir = path.join(base, ".workbench")
  fs.mkdirSync(stateDir, { recursive: true })

  const outside = path.join(base, "outside.txt")
  fs.writeFileSync(outside, "nope", "utf8")

  assert.throws(() => readTextArtifact({ baseDir: stateDir, p: outside }), /outside allowed base/i)
})

test("readImageArtifact reads png as base64 and reports mimeType", () => {
  const base = mkTmpDir()
  const stateDir = path.join(base, ".workbench")
  fs.mkdirSync(stateDir, { recursive: true })

  // 1x1 transparent PNG
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6q7l0AAAAASUVORK5CYII="
  const pngPath = path.join(stateDir, "one.png")
  fs.writeFileSync(pngPath, Buffer.from(pngBase64, "base64"))

  const img = readImageArtifact({ baseDir: stateDir, p: pngPath })
  assert.equal(img.mimeType, "image/png")
  assert.equal(img.dataBase64, pngBase64)
  assert.equal(img.bytes, Buffer.from(pngBase64, "base64").length)
})

test("artifacts readers deny protected auth area by default", () => {
  const base = mkTmpDir()
  const stateDir = path.join(base, ".workbench")
  fs.mkdirSync(path.join(stateDir, "auth"), { recursive: true })
  const secret = path.join(stateDir, "auth", "token.txt")
  fs.writeFileSync(secret, "SECRET", "utf8")
  assert.throws(() => readTextArtifact({ baseDir: stateDir, p: secret }), /access denied/i)
})
