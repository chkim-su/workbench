import { join } from "node:path"
import { JsonStore } from "./json-store.js"
import { workbenchStateDir } from "./base-dir.js"

export class McpRegistryStore {
  constructor(baseDir = workbenchStateDir()) {
    this.store = new JsonStore(join(baseDir, "registry", "mcp.json"))
  }

  async get() {
    return await this.store.read({
      version: 1,
      updatedAt: new Date().toISOString(),
      servers: {},
    })
  }

  async upsert(entry) {
    const prev = await this.get()
    const next = {
      ...prev,
      version: 1,
      updatedAt: new Date().toISOString(),
      servers: {
        ...prev.servers,
        [entry.name]: { ...entry, version: 1 },
      },
    }
    await this.store.write(next)
    return next
  }
}

