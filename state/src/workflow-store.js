import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { workbenchStateDir } from "./base-dir.js"

export class WorkflowStore {
  constructor(baseDir = workbenchStateDir()) {
    this.baseDir = baseDir
  }

  workflowDir(id) {
    return join(this.baseDir, "workflows", sanitizeId(id))
  }

  definitionPath(id) {
    return join(this.workflowDir(id), "definition.json")
  }

  statusPath(id) {
    return join(this.workflowDir(id), "status.json")
  }

  async list() {
    const dir = join(this.baseDir, "workflows")
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
  }

  async getDefinition(id) {
    try {
      const raw = await readFile(this.definitionPath(id), "utf8")
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async getStatus(id) {
    try {
      const raw = await readFile(this.statusPath(id), "utf8")
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async upload(def) {
    await mkdir(this.workflowDir(def.id), { recursive: true })
    await this.atomicWriteJson(this.definitionPath(def.id), def)
    const status = {
      version: 1,
      id: def.id,
      updatedAt: new Date().toISOString(),
      state: "uploaded",
    }
    await this.atomicWriteJson(this.statusPath(def.id), status)
    return status
  }

  async updateStatus(id, patch) {
    const prev =
      (await this.getStatus(id)) ?? ({
        version: 1,
        id,
        updatedAt: new Date().toISOString(),
        state: "uploaded",
      })

    const next = {
      ...prev,
      version: 1,
      updatedAt: new Date().toISOString(),
      state: patch.state ?? "updated",
      note: patch.note ?? prev.note,
      data: patch.data ?? prev.data,
    }
    await mkdir(this.workflowDir(id), { recursive: true })
    await this.atomicWriteJson(this.statusPath(id), next)
    return next
  }

  validate(def) {
    const errors = []
    if (!def || typeof def !== "object") return { valid: false, errors: ["workflow must be an object"] }
    const d = def
    if (typeof d.id !== "string" || !d.id) errors.push("workflow.id must be a non-empty string")
    if (!Array.isArray(d.steps)) errors.push("workflow.steps must be an array")
    if (typeof d.version !== "number") errors.push("workflow.version must be a number (set to 1)")

    const steps = Array.isArray(d.steps) ? d.steps : []
    for (const [i, s] of steps.entries()) {
      if (!s || typeof s !== "object") {
        errors.push(`workflow.steps[${i}] must be an object`)
        continue
      }
      if (typeof s.id !== "string" || !s.id) errors.push(`workflow.steps[${i}].id must be a non-empty string`)
      const kind = s.kind
      if (kind !== "note" && kind !== "tool") errors.push(`workflow.steps[${i}].kind must be "note" or "tool"`)
      if (kind === "note" && (typeof s.note !== "string" || !s.note)) errors.push(`workflow.steps[${i}].note must be a non-empty string`)
      if (kind === "tool" && (typeof s.tool !== "string" || !s.tool)) errors.push(`workflow.steps[${i}].tool must be a non-empty string`)
    }

    if (errors.length) return { valid: false, errors }
    return { valid: true, workflow: d }
  }

  async atomicWriteJson(path, value) {
    const dir = dirname(path)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}.json`)
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8")
    await rename(tmp, path)
  }
}

function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}

