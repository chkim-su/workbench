import { mkdir, readFile, writeFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { StdioJsonRpcClient } from "../mcp/kit/src/index.js"

async function main() {
  const cli = parseCliArgs(process.argv.slice(2))
  const repoRoot = process.cwd()
  const fast = process.env.WORKBENCH_VERIFY_FAST === "1"
  const strict = process.env.WORKBENCH_VERIFY_STRICT === "1"
  const skipDocker = process.env.WORKBENCH_SKIP_DOCKER === "1"
  const startupTimeoutMs = 10_000
  const startedAt = new Date().toISOString()
  const runId = `verify_${Date.now()}`
  const base = process.env.WORKBENCH_STATE_DIR ?? join(repoRoot, ".workbench")
  const outDir = join(base, "verify", "gates", runId)
  await mkdir(outDir, { recursive: true })

  const summary = {
    version: 1,
    runId,
    repoRoot,
    startedAt,
    completedAt: null,
    gates: [],
    registryPath: join(base, "registry", "mcp.json"),
    dockerArtifactsDir: null,
    nextActions: [],
  }

  const recordGate = (gate) => {
    summary.gates.push({ ...gate, at: new Date().toISOString() })
  }

  const writeSummary = async () => {
    summary.completedAt = new Date().toISOString()
    await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8")

    // Update pointer file for TUI state aggregation
    const currentPath = join(base, "state", "current.json")
    await mkdir(join(base, "state"), { recursive: true })
    let current = {}
    try {
      if (existsSync(currentPath)) {
        current = JSON.parse(await readFile(currentPath, "utf8"))
      }
    } catch {
      current = { schemaVersion: 1 }
    }
    current.verifyRunId = runId
    current.updatedAt = new Date().toISOString()
    await writeFile(currentPath, JSON.stringify(current, null, 2) + "\n", "utf8")

    return outDir
  }

  console.log(`[verify] repoRoot=${repoRoot}`)
  console.log(`[verify] outDir=${outDir}`)

  // TEST GATE 0: control-plane hygiene (manifest uniqueness + .mcp.json consistency)
  {
    console.log("[verify] gate0: control-plane hygiene")
    let gateError
    try {
      const report = await checkControlPlaneHygiene(repoRoot)
      if (!report.ok) {
        recordGate({ name: "gate0.control_plane", ok: false, error: report.error, details: report.details, nextActions: report.nextActions })
        await writeSummary()
        throw new Error(report.error || "control-plane hygiene failed")
      }
      recordGate({ name: "gate0.control_plane", ok: true, details: report.details })
      console.log("[verify] gate0: ok")
    } catch (e) {
      gateError = e
    }
    if (gateError) throw gateError
  }

  // TEST GATE 1: workflow server initialize + tools/list
  {
    if (cli.onlyGate && cli.onlyGate !== "gate1") {
      recordGate({ name: "gate1", ok: true, skipped: true, reason: `--gate ${cli.onlyGate}` })
    } else {
    console.log("[verify] gate1: workflow initialize + tools/list")
    const workflow = StdioJsonRpcClient.spawn(["bun", "mcp/servers/workflow/src/index.js"], { cwd: repoRoot, env: process.env })
    let gateError
    try {
      const init = await workflow.initialize(startupTimeoutMs)
      assertOk(init, "workflow.initialize")
      const tools = await workflow.toolsList(startupTimeoutMs)
      assertOk(tools, "workflow.tools/list")
    } catch (e) {
      gateError = e
    } finally {
      workflow.kill()
    }
    if (gateError) {
      const stderr = workflow.stderrText()
      if (stderr.trim()) console.error(`[verify] gate1 stderr:\n${stderr}`)
      recordGate({ name: "gate1", ok: false, error: String(gateError), stderr, nextActions: ["Run: bun mcp/servers/workflow/src/index.js and check stderr"] })
      await writeSummary()
      throw gateError
    }
    recordGate({ name: "gate1", ok: true })
    console.log("[verify] gate1: ok")
    }
  }

  // TEST GATE 2: registry scan + persisted state
  {
    if (cli.onlyGate && cli.onlyGate !== "gate2") {
      recordGate({ name: "gate2", ok: true, skipped: true, reason: `--gate ${cli.onlyGate}` })
    } else {
    console.log("[verify] gate2: registry.scan persists .workbench/registry/mcp.json")
    const registry = StdioJsonRpcClient.spawn(["bun", "mcp/servers/registry/src/index.js"], { cwd: repoRoot, env: process.env })
    let gateError
    try {
      assertOk(await registry.initialize(startupTimeoutMs), "registry.initialize")
      const scan = await registry.toolsCall("workbench.registry.scan", { timeoutMs: startupTimeoutMs }, 30_000)
      assertOk(scan, "registry.scan")

      const raw = await readFile(summary.registryPath, "utf8")
      const json = JSON.parse(raw)
      if (!json?.servers?.["workbench.workflow"]) throw new Error("registry missing workbench.workflow")
      if (!json?.servers?.["workbench.docker"]) throw new Error("registry missing workbench.docker")

      // Control-plane hygiene: enforce tool prefix == server name
      for (const [serverName, server] of Object.entries(json.servers || {})) {
        const tools = Array.isArray(server?.tools) ? server.tools : []
        const bad = tools.filter((t) => typeof t === "string" && !t.startsWith(`${serverName}.`))
        if (bad.length) {
          throw new Error(`registry tools not prefixed with server name (${serverName}): ${bad.slice(0, 5).join(", ")}`)
        }
      }
    } catch (e) {
      gateError = e
    } finally {
      registry.kill()
    }
    if (gateError) {
      const stderr = registry.stderrText()
      if (stderr.trim()) console.error(`[verify] gate2 stderr:\n${stderr}`)
      recordGate({
        name: "gate2",
        ok: false,
        error: String(gateError),
        stderr,
        nextActions: ["Run: bun mcp/servers/registry/src/index.js and call tool workbench.registry.scan"],
      })
      await writeSummary()
      throw gateError
    }
    recordGate({ name: "gate2", ok: true })
    console.log("[verify] gate2: ok")
    }
  }

  // TEST GATE 3: workflow upload/status/update/status state transitions
  {
    if (cli.onlyGate && cli.onlyGate !== "gate3") {
      recordGate({ name: "gate3", ok: true, skipped: true, reason: `--gate ${cli.onlyGate}` })
    } else {
    console.log("[verify] gate3: workflow upload/status/update/status transitions")
    const workflow = StdioJsonRpcClient.spawn(["bun", "mcp/servers/workflow/src/index.js"], { cwd: repoRoot, env: process.env })
    let gateError
    try {
      assertOk(await workflow.initialize(startupTimeoutMs), "workflow.initialize(2)")

      const wf = { version: 1, id: `wf_${Date.now()}`, steps: [{ id: "s1", kind: "note", note: "hello" }] }

      const uploaded = await workflow.toolsCall("workbench.workflow.upload", { workflow: wf }, 5000)
      assertOk(uploaded, "workflow.upload")

      const status1 = await workflow.toolsCall("workbench.workflow.status", { id: wf.id }, 5000)
      assertOk(status1, "workflow.status(1)")
      if (status1.result?.content?.[0]?.json?.status?.state !== "uploaded") throw new Error("expected status.state=uploaded")

      const updated = await workflow.toolsCall("workbench.workflow.update", { id: wf.id, note: "updated" }, 5000)
      assertOk(updated, "workflow.update")

      const status2 = await workflow.toolsCall("workbench.workflow.status", { id: wf.id }, 5000)
      assertOk(status2, "workflow.status(2)")
      if (status2.result?.content?.[0]?.json?.status?.state !== "updated") throw new Error("expected status.state=updated")
    } catch (e) {
      gateError = e
    } finally {
      workflow.kill()
    }
    if (gateError) {
      const stderr = workflow.stderrText()
      if (stderr.trim()) console.error(`[verify] gate3 stderr:\n${stderr}`)
      recordGate({ name: "gate3", ok: false, error: String(gateError), stderr, nextActions: ["Inspect state under .workbench/workflows/ for latest wf_*"] })
      await writeSummary()
      throw gateError
    }
    recordGate({ name: "gate3", ok: true })
    console.log("[verify] gate3: ok")
    }
  }

  // TEST GATE 4: docker harness (may require docker daemon permissions)
  {
    if (cli.onlyGate && cli.onlyGate !== "gate4") {
      recordGate({ name: "gate4", ok: true, skipped: true, reason: `--gate ${cli.onlyGate}` })
    } else {
    console.log("[verify] gate4: docker tools (may require docker daemon permission)")
    if (fast) {
      console.log("[verify] gate4: SKIP (WORKBENCH_VERIFY_FAST=1)")
      recordGate({ name: "gate4", ok: true, skipped: true, reason: "fast mode", nextActions: ["Run full: workbench verify --full"] })
    } else if (skipDocker) {
      console.log("[verify] gate4: SKIP (WORKBENCH_SKIP_DOCKER=1)")
      recordGate({
        name: "gate4",
        ok: true,
        skipped: true,
        nextActions: ["Unset WORKBENCH_SKIP_DOCKER=1 and rerun to validate Docker dogfooding"],
      })
    } else {

    const docker = StdioJsonRpcClient.spawn(["bun", "mcp/servers/docker/src/index.js"], { cwd: repoRoot, env: process.env })
    let gateError
    let probeJson = null
    let probeNextActions = []
    try {
      assertOk(await docker.initialize(startupTimeoutMs), "docker.initialize")
      const probe = await docker.toolsCall("workbench.docker.probe", {}, 10_000)
      if (probe.error) throw new Error(`docker.probe jsonrpc error: ${probe.error.message ?? "unknown"}`)
      probeJson = probe.result?.content?.[0]?.json
      if (probe.result?.isError) {
        console.error("[verify] gate4 probe:", JSON.stringify(probeJson, null, 2))
        probeNextActions = probeJson?.nextActions ?? []
        throw new Error(`docker daemon not usable. Next actions: ${probeNextActions.join(" | ")}`)
      }

      const run = await docker.toolsCall(
        "workbench.docker.run",
        { image: "alpine:3.19", cmd: ["sh", "-lc", "echo workbench-docker-ok"], pull: "missing" },
        120_000,
      )
      if (run.error) throw new Error(`docker.run jsonrpc error: ${run.error.message ?? "unknown"}`)
      const runJson = run.result?.content?.[0]?.json
      if (run.result?.isError) {
        throw new Error(`docker.run failed (exitCode=${runJson?.exitCode ?? "?"}). See artifacts: ${runJson?.artifacts?.dir ?? "?"}`)
      }
      const stdoutPath = runJson?.artifacts?.stdout
      if (!stdoutPath) throw new Error("docker.run did not return stdout artifact path")
      const stdout = await readFile(stdoutPath, "utf8").catch(() => "")
      if (!stdout.includes("workbench-docker-ok")) {
        throw new Error(`docker.run stdout missing marker. stdoutPath=${stdoutPath}`)
      }
      summary.dockerArtifactsDir = runJson?.artifacts?.dir ?? null
      console.log(`[verify] gate4 docker artifacts: ${summary.dockerArtifactsDir ?? ""}`)
    } catch (e) {
      gateError = e
    } finally {
      docker.kill()
    }
    if (gateError) {
      const stderr = docker.stderrText()
      if (stderr.trim()) console.error(`[verify] gate4 stderr:\n${stderr}`)
      if (probeJson && probeNextActions.length) {
        recordGate({
          name: "gate4",
          ok: false,
          error: "docker daemon not usable",
          probe: probeJson,
          nextActions: probeNextActions,
        })
        summary.nextActions.push(...probeNextActions)
      } else {
      recordGate({
        name: "gate4",
        ok: false,
        error: String(gateError),
        stderr,
        nextActions: ["Run: docker version", "Ensure your user can access /var/run/docker.sock", "Rerun: bun run verify"],
      })
      }
      await writeSummary()
      throw gateError
    }
    recordGate({ name: "gate4", ok: true, dockerArtifactsDir: summary.dockerArtifactsDir })
    console.log("[verify] gate4: ok")
    }
    }
  }

  // TEST GATE 5: runner dogfooding (mock always; real optional)
  {
    if (cli.onlyGate && cli.onlyGate !== "gate5") {
      recordGate({ name: "gate5.oauth.pool.rotation", ok: true, skipped: true, reason: `--gate ${cli.onlyGate}` })
      recordGate({ name: "gate5.runner.mock", ok: true, skipped: true, reason: `--gate ${cli.onlyGate}` })
      recordGate({ name: "gate5.runner.real", ok: true, skipped: true, reason: `--gate ${cli.onlyGate}` })
    } else {
    if (fast) {
      console.log("[verify] gate5: SKIP oauth pool rotation (fast)")
      recordGate({ name: "gate5.oauth.pool.rotation", ok: true, skipped: true, reason: "fast mode" })
    } else {
      console.log("[verify] gate5: oauth pool rotation (deterministic)")
    let rotErr
    try {
      const rot = await runPythonGate("verify/oauth_pool_rotation_test.py", repoRoot, 30_000)
      if (rot.exitCode !== 0) throw new Error(`oauth pool rotation test failed (exitCode=${rot.exitCode}). stderr=${rot.stderr}`)
      recordGate({ name: "gate5.oauth.pool.rotation", ok: true })
      console.log("[verify] gate5.oauth.pool.rotation: ok")
    } catch (e) {
      rotErr = e
    }
    if (rotErr) {
      recordGate({
        name: "gate5.oauth.pool.rotation",
        ok: false,
        error: String(rotErr),
        nextActions: ["Run: python3 verify/oauth_pool_rotation_test.py", "Inspect: .workbench/auth/openai_codex_oauth_pool.json (if using real OAuth)"],
      })
      await writeSummary()
      throw rotErr
    }
    }

    console.log("[verify] gate5: runner smoke (mock)")
    let gateError
    try {
      const mock = await runRunnerSmoke({ WORKBENCH_PROVIDER: "mock" }, repoRoot, 60_000)
      if (mock.exitCode !== 0) throw new Error(`runner (mock) failed (exitCode=${mock.exitCode})`)
      if (!mock.summary?.toolCallsSeen?.length) throw new Error("runner (mock) did not record any tool calls")
      recordGate({
        name: "gate5.runner.mock",
        ok: true,
        runDir: mock.summary.runDir,
        tools: mock.summary.toolCallsSeen,
        provider: mock.summary.provider,
      })
      console.log(`[verify] gate5.runner.mock: ok (${mock.summary.toolCallsSeen.length} tool calls)`)
      console.log(`[verify] gate5.runner.mock evidence: ${join(mock.summary.runDir, "events.jsonl")}`)
    } catch (e) {
      gateError = e
    }
    if (gateError) {
      recordGate({
        name: "gate5.runner.mock",
        ok: false,
        error: String(gateError),
        nextActions: ["Run: WORKBENCH_PROVIDER=mock python3 runner/run_smoke.py", "Inspect: .workbench/runs/<runId>/events.jsonl"],
      })
      await writeSummary()
      throw gateError
    }

    console.log("[verify] gate5: runner smoke (real, optional)")
    const realDecision = decideRunnerReal(process.env)
    if (!realDecision.shouldRun) {
      recordGate({
        name: "gate5.runner.real",
        ok: true,
        skipped: true,
        reason: realDecision.reason,
        nextActions: realDecision.nextActions,
      })
      console.log(`[verify] gate5.runner.real: SKIP (${realDecision.reason})`)
    } else {
      let realErr
      try {
        const real = await runRunnerSmoke({ WORKBENCH_OPENAI_OAUTH_AUTOSYNC_OPENCODE: "1" }, repoRoot, 120_000)
        if (real.exitCode !== 0) {
          const hint =
            real.summary?.error ||
            (real.stderr?.trim() ? real.stderr.trim().slice(-500) : "") ||
            (real.stdout?.trim() ? real.stdout.trim().slice(-500) : "")
          throw new Error(`runner (real) failed (exitCode=${real.exitCode}). ${hint}`.trim())
        }
        if (!real.summary?.toolCallsSeen?.length) throw new Error("runner (real) did not record any tool calls")
        recordGate({
          name: "gate5.runner.real",
          ok: true,
          runDir: real.summary.runDir,
          tools: real.summary.toolCallsSeen,
          provider: real.summary.provider,
        })
        console.log(`[verify] gate5.runner.real: ok (${real.summary.toolCallsSeen.length} tool calls)`)
        console.log(`[verify] gate5.runner.real evidence: ${join(real.summary.runDir, "events.jsonl")}`)
      } catch (e) {
        realErr = e
      }
      if (realErr) {
        recordGate({ name: "gate5.runner.real", ok: false, error: String(realErr), nextActions: realDecision.nextActions })
        summary.nextActions.push(...(realDecision.nextActions || []))
        await writeSummary()
        console.log("[verify] gate5.runner.real: FAILED")
        printOneNextAction(summary)
        if (strict) throw realErr
        process.exitCode = 1
      }
    }
    }
  }

  // TEST GATE 6: TUI smoke (Dockerized Bubble Tea)
  {
    if (cli.onlyGate && cli.onlyGate !== "gate6") {
      recordGate({ name: "gate6.tui.smoke", ok: true, skipped: true, reason: `--gate ${cli.onlyGate}` })
    } else if (fast) {
      recordGate({ name: "gate6.tui.smoke", ok: true, skipped: true, reason: "fast mode", nextActions: ["Run full: workbench verify --full"] })
    } else if (skipDocker) {
      recordGate({
        name: "gate6.tui.smoke",
        ok: true,
        skipped: true,
        reason: "WORKBENCH_SKIP_DOCKER=1",
        nextActions: ["Unset WORKBENCH_SKIP_DOCKER=1 and rerun to validate dockerized TUI smoke"],
      })
    } else {
      console.log("[verify] gate6: tui smoke (dockerized)")
      const docker = StdioJsonRpcClient.spawn(["bun", "mcp/servers/docker/src/index.js"], { cwd: repoRoot, env: process.env })
      let gateError
      try {
        assertOk(await docker.initialize(startupTimeoutMs), "docker.initialize(gate6)")
        const sharedCacheHost = join(repoRoot, ".workbench", "cache")
        await mkdir(join(sharedCacheHost, "go", "mod"), { recursive: true })
        await mkdir(join(sharedCacheHost, "go", "build"), { recursive: true })
        await mkdir(join(sharedCacheHost, "go", "gopath"), { recursive: true })
        await mkdir(join(sharedCacheHost, "xdg"), { recursive: true })
        await mkdir(join(sharedCacheHost, "home"), { recursive: true })
        const outDirInState = join(base, "verify", "tui", runId)
        await mkdir(outDirInState, { recursive: true })

        const outDirInContainer = `/state/verify/tui/${runId}`
        const user = typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : undefined
        const run = await docker.toolsCall(
          "workbench.docker.run",
          {
            image: "golang:1.22",
            pull: "missing",
            workdir: "/repo/ui/tui",
            user,
            env: {
              WORKBENCH_STATE_DIR: "/state",
              WORKBENCH_TUI_SMOKE_OUT_DIR: outDirInContainer,
              HOME: "/cache/home",
              XDG_CACHE_HOME: "/cache/xdg",
              GOPATH: "/cache/go/gopath",
              GOMODCACHE: "/cache/go/mod",
              GOCACHE: "/cache/go/build",
            },
            mounts: [
              { hostPath: ".", containerPath: "/repo", mode: "ro" },
              { hostPath: base, containerPath: "/state", mode: "rw" },
              { hostPath: sharedCacheHost, containerPath: "/cache", mode: "rw" },
            ],
            cmd: ["bash", "-c", "go test ./... && go run . --smoke"],
          },
          180_000,
        )
        if (run.error) throw new Error(`docker.run jsonrpc error: ${run.error.message ?? "unknown"}`)
        const runJson = run.result?.content?.[0]?.json
        if (run.result?.isError) {
          throw new Error(`tui smoke container failed (exitCode=${runJson?.exitCode ?? "?"}). See artifacts: ${runJson?.artifacts?.dir ?? "?"}`)
        }

        const stdoutPath = runJson?.artifacts?.stdout
        const stdout = stdoutPath ? await readFile(stdoutPath, "utf8").catch(() => "") : ""
        if (!stdout.includes("tui-smoke-ok")) {
          throw new Error(`tui smoke marker missing from stdout. stdoutPath=${stdoutPath ?? "?"}`)
        }

        const smokeSummaryPath = join(base, "verify", "tui", runId, "summary.json")
        const smokeSummaryRaw = await readFile(smokeSummaryPath, "utf8").catch(() => "")
        const smokeSummary = smokeSummaryRaw ? JSON.parse(smokeSummaryRaw) : null
        if (!smokeSummary?.ok) throw new Error("tui smoke summary missing or not ok")
        if (smokeSummary?.commandPaletteOpened !== true) throw new Error("tui smoke did not open session command palette overlay")
        if (smokeSummary?.systemPaletteOpened !== true) throw new Error("tui smoke did not open system (//) command palette overlay")
        if (smokeSummary?.systemPaletteHasDocker !== true) throw new Error("tui smoke did not suggest //docker for query 'd'")
        if (smokeSummary?.escClosedPalette !== true) throw new Error("tui smoke did not close palette via Esc while keeping cockpit")
        if (smokeSummary?.backToLauncher !== true) throw new Error("tui smoke did not navigate back to launcher via Esc screen stack")
        if (smokeSummary?.quitConfirmOpened !== true) throw new Error("tui smoke did not open quit confirmation via Esc at launcher root")
        if (smokeSummary?.modelSelectOpened !== true) throw new Error("tui smoke did not open //model selection overlay")
        if (smokeSummary?.modelChanged !== true) throw new Error("tui smoke did not change the model via //model")
        if (smokeSummary?.quickActionsOpened !== true) throw new Error("tui smoke did not open quick actions overlay")

        const sess = smokeSummary?.sessionId
        if (typeof sess !== "string" || !sess.startsWith("sess_")) throw new Error("tui smoke summary missing sessionId")
        const eventsPath = join(base, sess, "events.jsonl")
        const eventsRaw = await readFile(eventsPath, "utf8").catch(() => "")
        const types = new Set(
          eventsRaw
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l)?.type ?? null
              } catch {
                return null
              }
            })
            .filter(Boolean),
        )
        for (const t of ["ui.nav.push", "ui.nav.pop", "ui.overlay.open", "ui.overlay.close", "command.submitted", "system.alert"]) {
          if (!types.has(t)) throw new Error(`tui smoke missing required event type: ${t} (eventsPath=${eventsPath})`)
        }

        recordGate({
          name: "gate6.tui.smoke",
          ok: true,
          dockerArtifactsDir: runJson?.artifacts?.dir ?? null,
          tuiArtifactsDir: join(base, "verify", "tui", runId),
        })
        console.log("[verify] gate6: ok")
      } catch (e) {
        gateError = e
      } finally {
        docker.kill()
      }
      if (gateError) {
        recordGate({
          name: "gate6.tui.smoke",
          ok: false,
          error: String(gateError),
          nextActions: [
            "Ensure Docker socket is accessible; rerun: workbench verify --full",
            "Inspect: .workbench/verify/docker/<runId>/",
            "Inspect: .workbench/verify/tui/<verifyRunId>/summary.json",
          ],
        })
        await writeSummary()
        throw gateError
      }
    }
  }

  // TEST GATE 7: OAuth pool deterministic selection (python)
  {
    if (cli.onlyGate && cli.onlyGate !== "gate7") {
      recordGate({ name: "gate7.oauth.deterministic", ok: true, skipped: true, reason: `--gate ${cli.onlyGate}` })
    } else {
      console.log("[verify] gate7: oauth deterministic selection")
      let gateError
      try {
        const r1 = await runLocal(["python3", "verify/oauth_pool_rotation_test.py"], { cwd: repoRoot, env: process.env }, 30_000)
        if (r1.exitCode !== 0) throw new Error(`oauth_pool_rotation_test.py failed. stderr=${r1.stderr.slice(0, 400)}`)
        const r2 = await runLocal(["python3", "verify/oauth_pool_deterministic_selection_test.py"], { cwd: repoRoot, env: process.env }, 30_000)
        if (r2.exitCode !== 0) throw new Error(`oauth_pool_deterministic_selection_test.py failed. stderr=${r2.stderr.slice(0, 400)}`)
      } catch (e) {
        gateError = e
      }
      if (gateError) {
        recordGate({ name: "gate7.oauth.deterministic", ok: false, error: String(gateError) })
        await writeSummary()
        throw gateError
      }
      recordGate({ name: "gate7.oauth.deterministic", ok: true })
      console.log("[verify] gate7: ok")
    }
  }

  // TEST GATE 8: CLI command-bus replay determinism (dockerized)
  {
    if (cli.onlyGate && cli.onlyGate !== "gate8") {
      recordGate({ name: "gate8.dev.replay", ok: true, skipped: true, reason: `--gate ${cli.onlyGate}` })
    } else if (fast) {
      recordGate({ name: "gate8.dev.replay", ok: true, skipped: true, reason: "fast mode", nextActions: ["Run full: workbench verify --full"] })
    } else if (skipDocker) {
      recordGate({ name: "gate8.dev.replay", ok: true, skipped: true, reason: "WORKBENCH_SKIP_DOCKER=1", nextActions: ["Unset WORKBENCH_SKIP_DOCKER=1 and rerun"] })
    } else {
      console.log("[verify] gate8: dev replay determinism (dockerized)")
      const docker = StdioJsonRpcClient.spawn(["bun", "mcp/servers/docker/src/index.js"], { cwd: repoRoot, env: process.env })
      let gateError
      try {
        assertOk(await docker.initialize(startupTimeoutMs), "docker.initialize(gate8)")
        const sharedCacheHost = join(repoRoot, ".workbench", "cache")
        await mkdir(join(sharedCacheHost, "go", "mod"), { recursive: true })
        await mkdir(join(sharedCacheHost, "go", "build"), { recursive: true })
        await mkdir(join(sharedCacheHost, "go", "gopath"), { recursive: true })
        await mkdir(join(sharedCacheHost, "xdg"), { recursive: true })
        await mkdir(join(sharedCacheHost, "home"), { recursive: true })
        const sessA = `sess_dev_replay_${runId}_a`
        const sessB = `sess_dev_replay_${runId}_b`
        const user = typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : undefined
        const script = [
          "set -euo pipefail",
          "cd /repo/ui/tui",
          `mkdir -p /state/${sessA} /state/${sessB}`,
          `cat > /state/${sessA}/commands.jsonl <<'EOF'`,
          `{\"version\":1,\"type\":\"key\",\"source\":\"cli\",\"keys\":\"down enter enter\"}`,
          `{\"version\":1,\"type\":\"cmd\",\"source\":\"cli\",\"text\":\"//stats\"}`,
          `{\"version\":1,\"type\":\"send\",\"source\":\"cli\",\"text\":\"hello\"}`,
          `{\"version\":1,\"type\":\"stop\",\"source\":\"cli\"}`,
          "EOF",
          `cp /state/${sessA}/commands.jsonl /state/${sessB}/commands.jsonl`,
          `WORKBENCH_STATE_DIR=/state go test ./...`,
          `WORKBENCH_STATE_DIR=/state go run . --serve --session-id ${sessA}`,
          `WORKBENCH_STATE_DIR=/state go run . --serve --session-id ${sessB}`,
          "echo dev-replay-ok",
        ].join("\n")

        const run = await docker.toolsCall(
          "workbench.docker.run",
          {
            image: "golang:1.22",
            pull: "missing",
            workdir: "/repo/ui/tui",
            user,
            env: {
              WORKBENCH_STATE_DIR: "/state",
              HOME: "/cache/home",
              XDG_CACHE_HOME: "/cache/xdg",
              GOPATH: "/cache/go/gopath",
              GOMODCACHE: "/cache/go/mod",
              GOCACHE: "/cache/go/build",
            },
            mounts: [
              { hostPath: ".", containerPath: "/repo", mode: "ro" },
              { hostPath: base, containerPath: "/state", mode: "rw" },
              { hostPath: sharedCacheHost, containerPath: "/cache", mode: "rw" },
            ],
            cmd: ["bash", "-c", script],
          },
          240_000,
        )
        if (run.error) throw new Error(`docker.run(gate8) jsonrpc error: ${run.error.message ?? "unknown"}`)
        const runJson = run.result?.content?.[0]?.json
        if (run.result?.isError) {
          throw new Error(`gate8 container failed (exitCode=${runJson?.exitCode ?? "?"}). See artifacts: ${runJson?.artifacts?.dir ?? "?"}`)
        }

        const sumA = JSON.parse(await readFile(join(base, sessA, "summary.json"), "utf8"))
        const sumB = JSON.parse(await readFile(join(base, sessB, "summary.json"), "utf8"))
        for (const k of ["mode", "screen", "selectedModel"]) {
          if (sumA?.[k] !== sumB?.[k]) throw new Error(`gate8 mismatch: ${k} (A=${sumA?.[k]} B=${sumB?.[k]})`)
        }
        if (sumA?.mode !== "B" || sumA?.screen !== "cockpit") throw new Error("gate8 unexpected final state (expected mode=B screen=cockpit)")

        const eventsRaw = await readFile(join(base, sessA, "events.jsonl"), "utf8")
        if (!eventsRaw.includes("\"type\":\"command.submitted\"")) throw new Error("gate8 missing command.submitted in events")
        if (!eventsRaw.includes("\"source\":\"cli\"")) throw new Error("gate8 expected cli-sourced events for replay")

        recordGate({ name: "gate8.dev.replay", ok: true, dockerArtifactsDir: runJson?.artifacts?.dir ?? null })
        console.log("[verify] gate8: ok")
      } catch (e) {
        gateError = e
      } finally {
        docker.kill()
      }
      if (gateError) {
        recordGate({ name: "gate8.dev.replay", ok: false, error: String(gateError) })
        await writeSummary()
        throw gateError
      }
    }
  }

  const finalOutDir = await writeSummary()
  console.log(`[verify] summary: ${join(finalOutDir, "summary.json")}`)
  printOneNextAction(summary)
}

async function runLocal(cmd, opts, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(cmd[0], cmd.slice(1), { ...opts, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d) => (stdout += d.toString("utf8")))
    proc.stderr.on("data", (d) => (stderr += d.toString("utf8")))
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs)
    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

function parseCliArgs(argv) {
  let onlyGate = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--gate") onlyGate = argv[i + 1] ?? null
  }
  if (onlyGate !== null) {
    const g = String(onlyGate).trim()
    if (/^[0-9]+$/.test(g)) onlyGate = `gate${g}`
    else if (/^gate[0-9]+$/.test(g)) onlyGate = g
    else onlyGate = g
  }
  return { onlyGate }
}

async function checkControlPlaneHygiene(repoRoot) {
  const details = {}
  const nextActions = []

  const manifests = await loadV1Manifests(repoRoot)
  details.manifests = manifests.map((m) => ({ dir: m.dir, name: m.manifest.name, command: m.manifest.command }))

  const seen = new Map()
  const duplicates = []
  for (const m of manifests) {
    const name = m.manifest.name
    if (seen.has(name)) duplicates.push({ name, dirs: [seen.get(name), m.dir] })
    else seen.set(name, m.dir)
  }
  if (duplicates.length) {
    nextActions.push("Ensure each mcp/servers/*/manifest.json has a unique `name`.")
    return { ok: false, error: `duplicate MCP server names in manifests: ${duplicates.map((d) => `${d.name} (${d.dirs.join(" vs ")})`).join("; ")}`, details, nextActions }
  }

  const mcpConfigPath = join(repoRoot, ".mcp.json")
  if (existsSync(mcpConfigPath)) {
    try {
      const raw = await readFile(mcpConfigPath, "utf8")
      const cfg = JSON.parse(raw)
      const entries = cfg?.mcpServers && typeof cfg.mcpServers === "object" ? Object.entries(cfg.mcpServers) : []
      const mismatches = []

      for (const [label, entry] of entries) {
        const command = entry?.command
        const args = entry?.args
        if (typeof command !== "string" || !Array.isArray(args) || !args.every((x) => typeof x === "string")) continue
        const script = args[0] ?? ""
        if (!/^mcp\/servers\/[^/]+\/src\/index\.js$/.test(script)) continue
        const dir = script.split("/")[2]
        const manifest = manifests.find((m) => m.dir === dir)?.manifest
        if (!manifest) {
          mismatches.push({ label, reason: `missing manifest for ${dir}`, script })
          continue
        }
        const expectedCommand = manifest.command?.[0]
        const expectedArgs = manifest.command?.slice(1) ?? []
        if (command !== expectedCommand || JSON.stringify(args) !== JSON.stringify(expectedArgs)) {
          mismatches.push({ label, script, expected: { command: expectedCommand, args: expectedArgs }, actual: { command, args } })
        }
      }

      if (mismatches.length) {
        details.mcpConfigMismatches = mismatches
        nextActions.push("Update `.mcp.json` entries so `command` + `args` match the corresponding v1 `manifest.json`.")
        return { ok: false, error: `.mcp.json entries do not match manifest commands (${mismatches.length} mismatch(es))`, details, nextActions }
      }
    } catch (e) {
      nextActions.push("Fix `.mcp.json` to be valid JSON.")
      return { ok: false, error: `.mcp.json parse error: ${String(e)}`, details, nextActions }
    }
  }

  return { ok: true, details }
}

async function loadV1Manifests(repoRoot) {
  const serversDir = join(repoRoot, "mcp", "servers")
  const items = await readdir(serversDir, { withFileTypes: true }).catch(() => [])
  const out = []

  for (const item of items) {
    if (!item.isDirectory()) continue
    const manifestPath = join(serversDir, item.name, "manifest.json")
    const raw = await readFile(manifestPath, "utf8").catch(() => null)
    if (!raw) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object") continue
    if (parsed.version !== 1) continue
    if (parsed.transport !== "stdio") continue
    if (typeof parsed.name !== "string" || !parsed.name) continue
    if (!Array.isArray(parsed.command) || !parsed.command.every((x) => typeof x === "string" && x)) continue

    out.push({ dir: item.name, manifestPath, manifest: parsed })
  }

  return out
}

function assertOk(resp, label) {
  if (!resp || typeof resp !== "object") throw new Error(`${label}: no response`)
  if (resp.error) throw new Error(`${label}: jsonrpc error: ${resp.error?.message ?? "unknown"}`)
}

function decideRunnerReal(env) {
  const defaultBase = "https://api.openai.com/v1"
  const baseUrlEnv = (env.WORKBENCH_OPENAI_BASE_URL ?? "").trim()
  const modelEnv = (env.WORKBENCH_OPENAI_MODEL ?? "").trim()
  const providerMode = (env.WORKBENCH_PROVIDER ?? "auto").trim().toLowerCase()
  const allowNoAuth = (env.WORKBENCH_OPENAI_ALLOW_NOAUTH ?? "").trim() === "1"
  const key = (env.WORKBENCH_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? "").trim()

  const stateDir = (env.WORKBENCH_STATE_DIR ?? "").trim()
  const repoRoot = process.cwd()
  const base = stateDir || join(repoRoot, ".workbench")
  const oauthTokenPath = env.WORKBENCH_OPENAI_OAUTH_TOKEN_PATH ?? join(base, "auth", "openai_codex_oauth.json")
  const oauthPoolPath = env.WORKBENCH_OPENAI_OAUTH_POOL_PATH ?? join(base, "auth", "openai_codex_oauth_pool.json")
  const oauthClientId = (env.WORKBENCH_OPENAI_OAUTH_CLIENT_ID ?? "").trim()

  if (providerMode === "claude" || providerMode === "claude-code" || providerMode === "claude-tmux" || providerMode === "claude-code-raw") {
    const optIn = (env.WORKBENCH_VERIFY_REAL_LLM ?? "").trim() === "1"
    if (!optIn) {
      return { shouldRun: false, reason: "claude-code not opted-in", nextActions: ["export WORKBENCH_VERIFY_REAL_LLM=1; bun run verify"] }
    }
    return {
      shouldRun: true,
      reason: "claude-code selected",
      nextActions: ["Run: WORKBENCH_PROVIDER=claude-code python3 runner/run_smoke.py"],
    }
  }

  const anthropicKey = (env.WORKBENCH_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY ?? "").trim()
  const anthropicModel = (env.WORKBENCH_ANTHROPIC_MODEL ?? "").trim()

  if (providerMode === "openai-oauth" || providerMode === "openai-codex-oauth" || providerMode === "oauth-openai") {
    const optIn = (env.WORKBENCH_VERIFY_REAL_LLM ?? "").trim() === "1"
    const hasAnyToken = existsSync(oauthPoolPath) || existsSync(oauthTokenPath)
    if (!hasAnyToken) {
      return {
        shouldRun: false,
        reason: "openai oauth selected but no tokens found",
        nextActions: [
          "opencode auth login && workbench oauth-import-opencode",
          "workbench oauth-login --pool --profile account1  # workbench-managed OAuth (advanced)",
        ],
      }
    }
    if (!optIn) {
      return {
        shouldRun: false,
        reason: "openai oauth configured but not opted-in",
        nextActions: ["export WORKBENCH_VERIFY_REAL_LLM=1; workbench verify"],
      }
    }
    return {
      shouldRun: true,
      reason: "openai oauth selected",
      nextActions: [
        "Run: python3 runner/run_smoke.py",
        "If OAuth fails: opencode auth login && workbench oauth-import-opencode",
      ],
      oauthTokenPath,
      oauthPoolPath,
    }
  }

  if (providerMode === "anthropic") {
    if (!anthropicKey || !anthropicModel) {
      return {
        shouldRun: false,
        reason: "anthropic provider not fully configured",
        nextActions: [
          "export WORKBENCH_PROVIDER=anthropic WORKBENCH_ANTHROPIC_API_KEY=... WORKBENCH_ANTHROPIC_MODEL=claude-3-5-sonnet-latest WORKBENCH_VERIFY_REAL_LLM=1; bun run verify",
        ],
      }
    }
    const optIn = (env.WORKBENCH_VERIFY_REAL_LLM ?? "").trim() === "1"
    if (!optIn) {
      return {
        shouldRun: false,
        reason: "anthropic provider configured but not opted-in",
        nextActions: ["export WORKBENCH_VERIFY_REAL_LLM=1; bun run verify  # may incur API cost"],
      }
    }
    return { shouldRun: true, reason: "anthropic provider opted-in", nextActions: ["Run: python3 runner/run_smoke.py"] }
  }

  const isLocal = Boolean(baseUrlEnv) && baseUrlEnv.replace(/\/$/, "") !== defaultBase
  const wantsLocal = providerMode === "openai-local" || (providerMode === "auto" && isLocal)
  const wantsRemote = providerMode === "openai-remote" || (providerMode === "auto" && !isLocal)

  // In auto mode, prefer OAuth (no API keys) if configured.
  if (providerMode === "auto") {
    const hasToken = existsSync(oauthTokenPath) || existsSync(oauthPoolPath)
    if (hasToken) {
      const optIn = (env.WORKBENCH_VERIFY_REAL_LLM ?? "").trim() === "1"
      if (!optIn) {
        return {
          shouldRun: false,
          reason: "openai oauth token present but not opted-in",
          nextActions: ["export WORKBENCH_PROVIDER=openai-oauth WORKBENCH_VERIFY_REAL_LLM=1; workbench verify"],
        }
      }
      return { shouldRun: true, reason: "openai oauth token present", nextActions: ["Run: python3 runner/run_smoke.py"] }
    }
    if (oauthClientId) {
      return {
        shouldRun: false,
        reason: "openai oauth client configured but not logged in",
        nextActions: ["workbench oauth-login  # or: opencode auth login && workbench oauth-import-opencode"],
      }
    }
  }

  if (wantsLocal) {
    if (!baseUrlEnv || !modelEnv) {
      return {
        shouldRun: false,
        reason: "local provider not fully configured",
        nextActions: [
          "export WORKBENCH_PROVIDER=openai-local WORKBENCH_OPENAI_BASE_URL=http://127.0.0.1:11434/v1 WORKBENCH_OPENAI_MODEL=<your-model> WORKBENCH_OPENAI_ALLOW_NOAUTH=1; bun run verify",
        ],
      }
    }
    if (!key && !allowNoAuth) {
      return {
        shouldRun: false,
        reason: "local provider missing auth opt-in",
        nextActions: ["export WORKBENCH_OPENAI_ALLOW_NOAUTH=1; bun run verify"],
      }
    }
    return { shouldRun: true, reason: "local provider configured", nextActions: ["Run: python3 runner/run_smoke.py"] }
  }

  if (wantsRemote) {
    if (!key) {
      return {
        shouldRun: false,
        reason: "no real LLM configured",
        nextActions: [
          "opencode auth login && workbench oauth-import-opencode",
          "export WORKBENCH_PROVIDER=claude-code WORKBENCH_VERIFY_REAL_LLM=1; workbench verify  # uses Claude Code raw via tmux",
        ],
      }
    }
    const optIn = (env.WORKBENCH_VERIFY_REAL_LLM ?? "").trim() === "1"
    if (!optIn) {
      return {
        shouldRun: false,
        reason: "remote provider configured but not opted-in",
        nextActions: ["export WORKBENCH_VERIFY_REAL_LLM=1; workbench verify  # may incur API cost"],
      }
    }
    return { shouldRun: true, reason: "remote provider opted-in", nextActions: ["Run: python3 runner/run_smoke.py"] }
  }

  return { shouldRun: false, reason: "unknown provider mode", nextActions: ["Set WORKBENCH_PROVIDER=mock|openai-local|openai-remote|anthropic"] }
}

function printOneNextAction(summary) {
  const failure = summary.gates.find((g) => g && g.ok === false)
  if (failure && Array.isArray(failure.nextActions) && failure.nextActions.length) {
    console.log(`[verify] nextAction: ${failure.nextActions[0]}`)
    return
  }
  const skip = summary.gates.find((g) => g && g.skipped && Array.isArray(g.nextActions) && g.nextActions.length)
  if (skip) {
    console.log(`[verify] nextAction: ${skip.nextActions[0]}`)
  }
}

async function runRunnerSmoke(envOverrides, repoRoot, timeoutMs) {
  const env = { ...process.env, ...envOverrides }
  const cmd = "python3"
  const args = ["runner/run_smoke.py", "--max-steps", "16"]
  const started = Date.now()

  const proc = spawn(cmd, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""

  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL")
    } catch {}
  }, timeoutMs)

  proc.stdout.on("data", (d) => (stdout += d.toString("utf8")))
  proc.stderr.on("data", (d) => (stderr += d.toString("utf8")))

  const exitCode = await new Promise((resolve) => proc.on("close", (code) => resolve(code ?? 1)))
  clearTimeout(timer)

  const parse = () => {
    const start = stdout.indexOf("{")
    const end = stdout.lastIndexOf("}")
    if (start === -1 || end === -1 || end <= start) return null
    try {
      return JSON.parse(stdout.slice(start, end + 1))
    } catch {
      return null
    }
  }

  const summary = parse()
  return { exitCode, stdout, stderr, durationMs: Date.now() - started, summary }
}

async function runPythonGate(scriptRel, repoRoot, timeoutMs) {
  const env = { ...process.env }
  const cmd = "python3"
  const args = [scriptRel]
  const proc = spawn(cmd, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL")
    } catch {}
  }, timeoutMs)
  proc.stdout.on("data", (d) => (stdout += d.toString("utf8")))
  proc.stderr.on("data", (d) => (stderr += d.toString("utf8")))
  const exitCode = await new Promise((resolve) => proc.on("close", (code) => resolve(code ?? 1)))
  clearTimeout(timer)
  return { exitCode, stdout, stderr }
}

try {
  await main()
} catch (e) {
  // Avoid stack traces; summarize and exit non-zero.
  console.error(`[verify] ERROR: ${String(e)}`)
  process.exitCode = 1
}
