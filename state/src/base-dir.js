import { join } from "node:path"

export function workbenchStateDir(cwd = process.cwd()) {
  return process.env.WORKBENCH_STATE_DIR ?? join(cwd, ".workbench")
}

