import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export class JsonStore {
  constructor(path) {
    this.path = path
  }

  async read(fallback) {
    try {
      const raw = await readFile(this.path, "utf8")
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  async write(value) {
    const dir = dirname(this.path)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}.json`)
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8")
    await rename(tmp, this.path)
  }
}

