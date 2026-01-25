import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createMcpStdioServer } from "../../../kit/src/index.js"

const server = createMcpStdioServer({ name: "workbench.docker", version: "0.0.0" })

async function runDocker(args, timeoutMs = 60_000) {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { exitCode, stdout, stderr }
}

function asResult(title, r) {
  const text = [title, `exitCode: ${r.exitCode}`, r.stdout ? `stdout:\n${r.stdout}` : "", r.stderr ? `stderr:\n${r.stderr}` : ""]
    .filter(Boolean)
    .join("\n")
  return { content: [{ type: "text", text }], isError: r.exitCode !== 0 }
}

server.tool(
  { name: "workbench.docker.version", description: "Get Docker client version (does not require daemon)." },
  async () => asResult("docker --version", await runDocker(["--version"], 10_000)),
)

server.tool(
  {
    name: "workbench.docker.probe",
    description:
      "Probe docker daemon connectivity and provide actionable diagnostics (daemon/socket/permissions/environment).",
  },
  async () => {
    const now = new Date().toISOString()
    const env = {
      DOCKER_HOST: process.env.DOCKER_HOST ?? null,
      DOCKER_CONTEXT: process.env.DOCKER_CONTEXT ?? null,
      WSL_INTEROP: process.env.WSL_INTEROP ?? null,
      WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME ?? null,
    }

    const sock = await Bun.spawn(["bash", "-lc", "ls -l /var/run/docker.sock 2>/dev/null || echo 'NO_SOCK'"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const sockOut = (await new Response(sock.stdout).text()).trim()
    const sockErr = (await new Response(sock.stderr).text()).trim()

    const idp = await Bun.spawn(["bash", "-lc", "id && echo '---' && groups"], { stdout: "pipe", stderr: "pipe" })
    const idOut = (await new Response(idp.stdout).text()).trim()

    const client = await runDocker(["--version"], 10_000)
    const version = await runDocker(["version"], 10_000)
    const info = await runDocker(["info"], 10_000)

    const combinedErrors = [version.stderr, info.stderr].filter(Boolean).join("\n")
    const daemonOk =
      version.exitCode === 0 && info.exitCode === 0 && !/permission denied|operation not permitted/i.test(combinedErrors)

    const nextActions = []
    if (/NO_SOCK/.test(sockOut)) {
      nextActions.push("Start Docker daemon (or enable Docker Desktop WSL integration) so /var/run/docker.sock exists.")
    }
    if (/operation not permitted/i.test(combinedErrors)) {
      nextActions.push(
        "This environment blocks connecting to the docker socket (operation not permitted). Re-run the workbench with Docker-enabled permissions (e.g. outside sandbox or with escalated execution).",
      )
    }
    if (/permission denied/i.test(combinedErrors)) {
      nextActions.push(
        "User lacks permission to access docker socket. Ensure your user is in the `docker` group and restart your shell/session.",
      )
      nextActions.push("As a temporary test: `sudo chmod 666 /var/run/docker.sock` (not recommended long-term).")
    }
    if (!nextActions.length && !daemonOk) {
      nextActions.push("Run `docker info` manually and follow the printed daemon-start instructions for your platform.")
    }

    return {
      content: [
        {
          type: "json",
          json: {
            at: now,
            env,
            socket: { stdout: sockOut, stderr: sockErr },
            identity: idOut,
            docker: {
              client: { exitCode: client.exitCode, stdout: client.stdout, stderr: client.stderr },
              version: { exitCode: version.exitCode, stdout: version.stdout, stderr: version.stderr },
              info: { exitCode: info.exitCode, stdout: info.stdout, stderr: info.stderr },
            },
            daemonOk,
            nextActions,
          },
        },
      ],
      isError: !daemonOk,
    }
  },
)

server.tool(
  {
    name: "workbench.docker.ps",
    description: "List containers (requires docker daemon).",
    inputSchema: { type: "object", additionalProperties: false, properties: { all: { type: "boolean" } } },
  },
  async (args) => {
    const a = args ?? {}
    const all = a.all === true
    return asResult("docker ps", await runDocker(all ? ["ps", "-a"] : ["ps"], 10_000))
  },
)

server.tool(
  {
    name: "workbench.docker.logs",
    description: "Fetch container logs (requires docker daemon).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["container"],
      properties: { container: { type: "string" }, tail: { type: "number" } },
    },
  },
  async (args) => {
    const a = args ?? {}
    const container = a.container
    if (typeof container !== "string" || !container) {
      return { content: [{ type: "text", text: "Missing required field: container" }], isError: true }
    }
    const tail = typeof a.tail === "number" && Number.isFinite(a.tail) ? Math.max(1, Math.min(5000, Math.floor(a.tail))) : undefined
    const dockerArgs = ["logs"]
    if (tail !== undefined) dockerArgs.push("--tail", String(tail))
    dockerArgs.push(container)
    return asResult(`docker logs ${container}`, await runDocker(dockerArgs, 10_000))
  },
)

server.tool(
  {
    name: "workbench.docker.run",
    description: "Run a container and capture stdout/stderr into .workbench/verify/docker/<runId>/ (requires daemon).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["image"],
      properties: {
        image: { type: "string" },
        cmd: { type: "array", items: { type: "string" } },
        pull: { type: "string", enum: ["never", "missing"] },
        workdir: { type: "string", description: "Container working directory (passed to docker -w)." },
        user: { type: "string", description: "Container user passed to docker --user (e.g. 1000:1000)." },
        env: {
          type: "object",
          description: "Environment variables passed via docker -e (string values only).",
          additionalProperties: { type: "string" },
        },
        mounts: {
          type: "array",
          description: "Optional bind mounts for verification (hostPath -> containerPath).",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["hostPath", "containerPath"],
            properties: {
              hostPath: { type: "string" },
              containerPath: { type: "string" },
              mode: { type: "string", enum: ["ro", "rw"] },
            },
          },
        },
      },
    },
  },
  async (args) => {
    const a = args ?? {}
    const image = a.image
    if (typeof image !== "string" || !image) {
      return { content: [{ type: "text", text: "Missing required field: image" }], isError: true }
    }

    const cmd = Array.isArray(a.cmd) && a.cmd.every((x) => typeof x === "string") ? a.cmd : []
    const pull = a.pull === "missing" ? "missing" : "never"
    const workdir = typeof a.workdir === "string" && a.workdir ? a.workdir : null
    const user = typeof a.user === "string" && a.user ? a.user : null
    const envObj = a.env && typeof a.env === "object" ? a.env : null

    const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const base = process.env.WORKBENCH_STATE_DIR ?? join(process.cwd(), ".workbench")
    const outDir = join(base, "verify", "docker", runId)
    await mkdir(outDir, { recursive: true })

    const dockerArgs = ["run", "--rm", "--pull", pull]

    if (workdir) dockerArgs.push("-w", workdir)
    if (user) dockerArgs.push("--user", user)

    if (envObj) {
      for (const [k, v] of Object.entries(envObj)) {
        if (typeof k !== "string" || !k) continue
        if (typeof v !== "string") continue
        dockerArgs.push("-e", `${k}=${v}`)
      }
    }

    const mounts = Array.isArray(a.mounts) ? a.mounts : []
    if (mounts.length) {
      const repoRootAbs = resolve(process.cwd())
      const stateDirAbs = resolve(process.env.WORKBENCH_STATE_DIR ?? join(process.cwd(), ".workbench"))

      for (const m of mounts) {
        if (!m || typeof m !== "object") continue
        const hostPathRaw = m.hostPath
        const containerPath = m.containerPath
        const mode = m.mode === "rw" ? "rw" : "ro"
        if (typeof hostPathRaw !== "string" || !hostPathRaw) continue
        if (typeof containerPath !== "string" || !containerPath.startsWith("/")) continue

        const hostPathAbs = resolve(process.cwd(), hostPathRaw)
        const allowed = hostPathAbs === repoRootAbs || hostPathAbs.startsWith(repoRootAbs + "/") || hostPathAbs === stateDirAbs || hostPathAbs.startsWith(stateDirAbs + "/")
        if (!allowed) {
          return {
            content: [
              {
                type: "text",
                text: `Mount hostPath is not allowed (must be under repo root or state dir). hostPath=${hostPathAbs}`,
              },
            ],
            isError: true,
          }
        }

        dockerArgs.push("-v", `${hostPathAbs}:${containerPath}:${mode}`)
      }
    }

    dockerArgs.push(image, ...cmd)
    const r = await runDocker(dockerArgs, 120_000)

    await Promise.all([
      writeFile(join(outDir, "stdout.txt"), r.stdout ?? "", "utf8"),
      writeFile(join(outDir, "stderr.txt"), r.stderr ?? "", "utf8"),
      writeFile(
        join(outDir, "meta.json"),
        JSON.stringify({ runId, image, cmd, pull, workdir, user, env: envObj, mounts, exitCode: r.exitCode }, null, 2) + "\n",
      ),
    ])

    return {
      content: [
        {
          type: "json",
          json: {
            runId,
            image,
            cmd,
            pull,
            exitCode: r.exitCode,
            artifacts: {
              dir: outDir,
              stdout: join(outDir, "stdout.txt"),
              stderr: join(outDir, "stderr.txt"),
              meta: join(outDir, "meta.json"),
            },
          },
        },
      ],
      isError: r.exitCode !== 0,
    }
  },
)

server.tool(
  {
    name: "workbench.docker.run_detached",
    description: "Run a container in detached mode and return the container id (requires daemon).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["image"],
      properties: {
        image: { type: "string" },
        name: { type: "string", description: "Optional container name passed to docker --name." },
        cmd: { type: "array", items: { type: "string" } },
        pull: { type: "string", enum: ["never", "missing"] },
        workdir: { type: "string", description: "Container working directory (passed to docker -w)." },
        user: { type: "string", description: "Container user passed to docker --user (e.g. 1000:1000)." },
        env: {
          type: "object",
          description: "Environment variables passed via docker -e (string values only).",
          additionalProperties: { type: "string" },
        },
        mounts: {
          type: "array",
          description: "Optional bind mounts (hostPath -> containerPath).",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["hostPath", "containerPath"],
            properties: {
              hostPath: { type: "string" },
              containerPath: { type: "string" },
              mode: { type: "string", enum: ["ro", "rw"] },
            },
          },
        },
      },
    },
  },
  async (args) => {
    const a = args ?? {}
    const image = a.image
    if (typeof image !== "string" || !image) {
      return { content: [{ type: "text", text: "Missing required field: image" }], isError: true }
    }

    const name = typeof a.name === "string" && a.name ? a.name : null
    const cmd = Array.isArray(a.cmd) && a.cmd.every((x) => typeof x === "string") ? a.cmd : []
    const pull = a.pull === "missing" ? "missing" : "never"
    const workdir = typeof a.workdir === "string" && a.workdir ? a.workdir : null
    const user = typeof a.user === "string" && a.user ? a.user : null
    const envObj = a.env && typeof a.env === "object" ? a.env : null

    const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const base = process.env.WORKBENCH_STATE_DIR ?? join(process.cwd(), ".workbench")
    const outDir = join(base, "verify", "docker", runId)
    await mkdir(outDir, { recursive: true })

    const dockerArgs = ["run", "-d", "--pull", pull]
    if (name) dockerArgs.push("--name", name)
    if (workdir) dockerArgs.push("-w", workdir)
    if (user) dockerArgs.push("--user", user)

    if (envObj) {
      for (const [k, v] of Object.entries(envObj)) {
        if (typeof k !== "string" || !k) continue
        if (typeof v !== "string") continue
        dockerArgs.push("-e", `${k}=${v}`)
      }
    }

    const mounts = Array.isArray(a.mounts) ? a.mounts : []
    if (mounts.length) {
      const repoRootAbs = resolve(process.cwd())
      const stateDirAbs = resolve(process.env.WORKBENCH_STATE_DIR ?? join(process.cwd(), ".workbench"))

      for (const m of mounts) {
        if (!m || typeof m !== "object") continue
        const hostPathRaw = m.hostPath
        const containerPath = m.containerPath
        const mode = m.mode === "rw" ? "rw" : "ro"
        if (typeof hostPathRaw !== "string" || !hostPathRaw) continue
        if (typeof containerPath !== "string" || !containerPath.startsWith("/")) continue

        const hostPathAbs = resolve(process.cwd(), hostPathRaw)
        const allowed =
          hostPathAbs === repoRootAbs ||
          hostPathAbs.startsWith(repoRootAbs + "/") ||
          hostPathAbs === stateDirAbs ||
          hostPathAbs.startsWith(stateDirAbs + "/")
        if (!allowed) {
          return {
            content: [{ type: "text", text: `Mount hostPath is not allowed (must be under repo root or state dir). hostPath=${hostPathAbs}` }],
            isError: true,
          }
        }
        dockerArgs.push("-v", `${hostPathAbs}:${containerPath}:${mode}`)
      }
    }

    dockerArgs.push(image, ...cmd)
    const r = await runDocker(dockerArgs, 60_000)

    await Promise.all([
      writeFile(join(outDir, "stdout.txt"), r.stdout ?? "", "utf8"),
      writeFile(join(outDir, "stderr.txt"), r.stderr ?? "", "utf8"),
      writeFile(join(outDir, "container_id.txt"), String((r.stdout ?? "").trim()) + "\n", "utf8"),
      writeFile(
        join(outDir, "meta.json"),
        JSON.stringify({ runId, image, cmd, pull, workdir, user, env: envObj, mounts, name, exitCode: r.exitCode }, null, 2) + "\n",
      ),
    ])

    const containerId = String((r.stdout ?? "").trim())
    return {
      content: [
        {
          type: "json",
          json: {
            runId,
            image,
            cmd,
            pull,
            name,
            containerId: containerId || null,
            exitCode: r.exitCode,
            artifacts: {
              dir: outDir,
              stdout: join(outDir, "stdout.txt"),
              stderr: join(outDir, "stderr.txt"),
              containerId: join(outDir, "container_id.txt"),
              meta: join(outDir, "meta.json"),
            },
          },
        },
      ],
      isError: r.exitCode !== 0 || !containerId,
    }
  },
)

server.tool(
  {
    name: "workbench.docker.stop",
    description: "Stop a container by id or name. Optionally remove it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["container"],
      properties: { container: { type: "string" }, remove: { type: "boolean" } },
    },
  },
  async (args) => {
    const a = args ?? {}
    const container = a.container
    if (typeof container !== "string" || !container) {
      return { content: [{ type: "text", text: "Missing required field: container" }], isError: true }
    }
    const remove = a.remove === true

    const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const base = process.env.WORKBENCH_STATE_DIR ?? join(process.cwd(), ".workbench")
    const outDir = join(base, "verify", "docker", runId)
    await mkdir(outDir, { recursive: true })

    const stop = await runDocker(["stop", container], 30_000)
    await Promise.all([
      writeFile(join(outDir, "stop.stdout.txt"), stop.stdout ?? "", "utf8"),
      writeFile(join(outDir, "stop.stderr.txt"), stop.stderr ?? "", "utf8"),
    ])

    let rm = null
    if (remove) {
      rm = await runDocker(["rm", "-f", container], 30_000)
      await Promise.all([
        writeFile(join(outDir, "rm.stdout.txt"), rm.stdout ?? "", "utf8"),
        writeFile(join(outDir, "rm.stderr.txt"), rm.stderr ?? "", "utf8"),
      ])
    }

    const ok = (!rm && stop.exitCode === 0) || (rm && rm.exitCode === 0)
    return {
      content: [
        {
          type: "json",
          json: {
            ok,
            container,
            remove,
            stop: { exitCode: stop.exitCode },
            rm: rm ? { exitCode: rm.exitCode } : null,
            artifacts: { dir: outDir },
          },
        },
      ],
      isError: !ok,
    }
  },
)

server.start()
