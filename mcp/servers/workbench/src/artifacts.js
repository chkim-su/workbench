import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex")
}

function guessMimeType(p) {
  const ext = path.extname(String(p || "")).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".gif") return "image/gif"
  if (ext === ".webp") return "image/webp"
  if (ext === ".svg") return "image/svg+xml"
  return "application/octet-stream"
}

function isWithinBase(baseReal, candidateReal) {
  if (candidateReal === baseReal) return true
  const prefix = baseReal.endsWith(path.sep) ? baseReal : baseReal + path.sep
  return candidateReal.startsWith(prefix)
}

const DEFAULT_DENY_TOP_LEVEL = new Set(["auth", "codex_home"])

/**
 * Resolve a user-supplied path to a realpath under baseDir.
 * - Requires the target to exist (so realpath can be computed).
 * - Rejects symlink escapes.
 */
export function resolveArtifactPath({ baseDir, p, denyTopLevel = DEFAULT_DENY_TOP_LEVEL }) {
  if (typeof p !== "string" || !p.trim()) {
    throw new Error("Missing path")
  }
  const baseAbs = path.resolve(baseDir)
  const baseReal = fs.realpathSync(baseAbs)

  // Resolve relative paths from the server's working directory (repo root),
  // then enforce that the real path is under the Workbench state directory.
  const candidateAbs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)
  const candidateReal = fs.realpathSync(candidateAbs)

  if (!isWithinBase(baseReal, candidateReal)) {
    throw new Error(`Path is outside allowed base dir. base=${baseReal} path=${candidateReal}`)
  }

  const rel = path.relative(baseReal, candidateReal)
  const top = rel.split(path.sep)[0]
  if (denyTopLevel && top && denyTopLevel.has(top)) {
    throw new Error(`Access denied for protected area: ${top}`)
  }

  return { baseReal, candidateAbs, candidateReal }
}

export function readTextArtifact({
  baseDir,
  p,
  maxBytes = 256 * 1024,
  tailBytes = null,
  encoding = "utf8",
}) {
  const { candidateReal } = resolveArtifactPath({ baseDir, p })

  const st = fs.statSync(candidateReal)
  if (!st.isFile()) throw new Error("Not a file")

  const max = Math.max(1, Math.min(5 * 1024 * 1024, Math.floor(Number(maxBytes) || 0)))
  const tail = tailBytes === null || tailBytes === undefined ? null : Math.max(1, Math.min(max, Math.floor(Number(tailBytes) || 0)))

  let start = 0
  let length = Math.min(st.size, max)
  if (tail !== null) {
    length = Math.min(st.size, tail)
    start = Math.max(0, st.size - length)
  }

  const fd = fs.openSync(candidateReal, "r")
  try {
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, start)
    const text = buf.toString(encoding)
    return {
      path: candidateReal,
      bytes: length,
      totalBytes: st.size,
      truncated: length < st.size,
      sha256: sha256(buf),
      text,
    }
  } finally {
    try { fs.closeSync(fd) } catch {}
  }
}

export function readImageArtifact({ baseDir, p, maxBytes = 2 * 1024 * 1024 }) {
  const { candidateReal } = resolveArtifactPath({ baseDir, p })

  const st = fs.statSync(candidateReal)
  if (!st.isFile()) throw new Error("Not a file")

  const max = Math.max(1, Math.min(8 * 1024 * 1024, Math.floor(Number(maxBytes) || 0)))
  if (st.size > max) {
    throw new Error(`Image too large (${st.size} bytes > ${max} bytes)`)
  }

  const buf = fs.readFileSync(candidateReal)
  const mimeType = guessMimeType(candidateReal)
  return {
    path: candidateReal,
    bytes: buf.length,
    sha256: sha256(buf),
    mimeType,
    dataBase64: buf.toString("base64"),
  }
}
