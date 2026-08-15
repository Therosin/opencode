import * as net from "node:net"
import { existsSync } from "node:fs"
import { basename, extname } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import * as vscode from "vscode"
const VIEW_CONTAINER = "workbench.view.extension.opencode-v2"
const READY_TIMEOUT_MS = 15_000
const WORKSPACE_WAIT_TIMEOUT_MS = 5_000
const HEALTH_PATHS = ["/global/health", "/api/health", "/health", "/app/providers"]

// Prefer a fixed port so the webview origin (and its localStorage) stays stable
// across launches; fall back to an ephemeral port only when the preferred one
// is already taken.
const PREFERRED_PORT = 4096

// --- port probing -------------------------------------------------------------

function tryListen(port: number): Promise<boolean> {
  const server = net.createServer()
  return new Promise((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true))
    })
  })
}

async function findFreePort(): Promise<number> {
  if (await tryListen(PREFERRED_PORT)) return PREFERRED_PORT
  const server = net.createServer()
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo
      server.close(() => resolve(address.port))
    })
  })
}

// Resolves the configured command to a directly spawnable executable on
// Windows, preferring a real .exe over .cmd/.bat shims so the workspace-
// configurable path is never interpreted by a shell (command injection).
async function resolveCommand(command: string): Promise<string> {
  if (process.platform !== "win32") return command
  const ext = extname(command).toLowerCase()
  if (ext === ".cmd" || ext === ".bat") {
    const exe = command.replace(/\.(cmd|bat)$/i, ".exe")
    if (existsSync(exe)) return exe
  }
  if (command.includes("\\") || command.includes("/") || ext !== "") return command

  const shims = await new Promise<string[]>((resolve) => {
    const child = spawn("where.exe", [command], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()))
    child.on("close", () => resolve(out.split(/\r?\n/).filter(Boolean)))
    child.on("error", () => resolve([]))
  })
  const exe = shims.find((entry) => extname(entry).toLowerCase() === ".exe")
  if (exe) return exe
  const shim = shims[0]
  if (!shim) return command
  const sibling = shim.replace(/\.(cmd|bat)$/i, ".exe")
  return existsSync(sibling) ? sibling : shim
}

async function createSession(url: string, title?: string): Promise<{ id: string } | undefined> {
  return fetch(`${url}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
    signal: AbortSignal.timeout(10_000),
  })
    .then((response) => (response.ok ? (response.json() as Promise<{ id: string }>) : undefined))
    .catch(() => undefined)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function directoryUrl(url: string, directory: string): string {
  const encoded = Buffer.from(directory, "utf8").toString("base64url")
  return `${url}/${encoded}/session`
}

function sessionUrl(url: string, directory: string, sessionID: string): string {
  const encoded = Buffer.from(directory, "utf8").toString("base64url")
  return `${url}/${encoded}/session/${sessionID}`
}

// --- server lifecycle ---------------------------------------------------------

class ServerManager implements vscode.Disposable {
  private child?: ChildProcess
  private readonly output: vscode.OutputChannel
  private url?: string
  private workspacePath?: string
  private sessionURL?: string
  private sessionPath?: string
  private lastStderr = ""
  private startPromise?: { workspacePath: string; promise: Promise<string> }

  constructor(output: vscode.OutputChannel) {
    this.output = output
  }

  get serverUrl() {
    return this.url
  }

  async start(workspacePath: string): Promise<string> {
    if (this.url && this.child && this.child.exitCode === null && this.workspacePath === workspacePath) return this.url
    if (this.child && this.child.exitCode === null) this.killChild()
    if (this.startPromise?.workspacePath === workspacePath) return this.startPromise.promise
    const promise = this.launchWithRetry(workspacePath)
    this.startPromise = { workspacePath, promise }
    try {
      return await promise
    } finally {
      if (this.startPromise?.promise === promise) this.startPromise = undefined
    }
  }

  private async launchWithRetry(workspacePath: string): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.launch(workspacePath)
      } catch (error) {
        this.output.appendLine(
          `Server start attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        this.killChild()
        if (attempt === 2) throw error
      }
    }
    throw new Error("Unable to start server")
  }

  private async launch(workspacePath: string): Promise<string> {
    const port = await findFreePort()
    const configured = vscode.workspace.getConfiguration("opencode-v2").get<string>("path")
    const command = await resolveCommand(configured ?? "opencode")
    const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
    const env = {
      ...process.env,
      // The server resolves its project directory from process.cwd() when no
      // location query/header is present, so start it inside the workspace.
      OPENCODE_WORKSPACE: workspacePath,
      // The panel webview cannot present Basic auth challenges or forward
      // URL-embedded credentials, so the localhost server must run unsecured.
      // This is safe because the server binds 127.0.0.1 only.
      OPENCODE_SERVER_PASSWORD: "",
    }

    this.output.appendLine(`Starting server: ${command} ${args.join(" ")} (cwd: ${workspacePath})`)
    this.lastStderr = ""
    this.url = undefined

    let child: ChildProcess
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
      // Residual .cmd/.bat shim without a sibling .exe: run it through cmd.exe
      // with the command path quoted so a workspace-configured path cannot
      // inject additional commands. Never use shell: true for the same reason.
      const cmdLine = `"${command}" ${args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ")}`
      child = spawn("cmd.exe", ["/d", "/s", "/c", cmdLine], {
        cwd: workspacePath,
        env,
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } else {
      child = spawn(command, args, {
        cwd: workspacePath,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    }
    this.child = child
    this.workspacePath = workspacePath

    let spawnError: Error | undefined
    // The child must always have an error listener attached; otherwise a
    // failed spawn (e.g. ENOENT for a missing binary) crashes the host.
    child.on("error", (error) => {
      spawnError = error
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      this.lastStderr = (this.lastStderr + text).slice(-2000)
      this.output.append(text)
    })
    child.stdout?.on("data", (chunk: Buffer) => this.output.append(chunk.toString()))
    child.on("exit", (code, signal) => {
      this.output.appendLine(`Server exited (code=${code}, signal=${signal})`)
      if (this.child === child) {
        this.url = undefined
        this.workspacePath = undefined
        this.sessionURL = undefined
        this.sessionPath = undefined
        this.child = undefined
      }
    })

    this.url = `http://127.0.0.1:${port}`
    await this.waitForReady(this.url, child, () => spawnError)
    return this.url
  }

  // Resolves the URL the panel should open for a workspace. A fresh session is
  // created per server start (no reconnecting to an old conversation), then
  // cached so panel refreshes restore the same session instead of duplicating.
  // Falls back to the bare directory route when the session API is unavailable.
  async resolveSessionURL(workspacePath: string): Promise<string> {
    const url = this.url
    if (!url) throw new Error("Server is not running")
    if (this.sessionURL && this.sessionPath === workspacePath) return this.sessionURL
    const session = await createSession(url, basename(workspacePath))
    this.sessionPath = workspacePath
    this.sessionURL = session ? sessionUrl(url, workspacePath, session.id) : directoryUrl(url, workspacePath)
    return this.sessionURL
  }

  private async waitForReady(url: string, child: ChildProcess, spawnError?: () => Error | undefined): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    let lastReason = "no response"
    while (Date.now() < deadline) {
      if (spawnError?.()) throw spawnError()
      if (child.exitCode !== null) {
        const stderr = this.lastStderr.trim()
        throw new Error(`Server exited with code ${child.exitCode}${stderr ? `: ${stderr.split("\n").at(-1)}` : ""}`)
      }
      const status = await this.checkServer(url)
      if (status.ok) {
        this.output.appendLine(`Server ready at ${url} (${status.path})`)
        return
      }
      lastReason = status.reason ?? lastReason
      await delay(250)
    }
    throw new Error(`Server did not become ready within ${READY_TIMEOUT_MS / 1000}s: ${lastReason}`)
  }

  private async checkServer(url: string): Promise<{ ok: boolean; path?: string; reason?: string }> {
    for (const candidate of HEALTH_PATHS) {
      try {
        const response = await fetch(url + candidate, {
          signal: AbortSignal.timeout(2_000),
        })
        if (response.ok) return { ok: true, path: candidate }
        if (response.status !== 404) return { ok: false, reason: `${response.status} at ${candidate}` }
      } catch {
        // Connection refused or timed out; keep polling.
      }
    }
    return { ok: false, reason: "endpoints unreachable" }
  }

  private killChild() {
    const child = this.child
    this.child = undefined
    this.url = undefined
    this.workspacePath = undefined
    this.sessionURL = undefined
    this.sessionPath = undefined
    if (!child) return
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
    } else {
      child.kill("SIGTERM")
    }
  }

  dispose() {
    this.killChild()
  }
}

// --- webview ------------------------------------------------------------------

function htmlFor(url: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline'">
  <style>
    body, html {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
  </style>
</head>
<body>
  <iframe src="${url}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
    <title>OpenCode Assistant</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 20px;
        }
        .error {
            color: var(--vscode-errorForeground);
            text-align: center;
            margin-top: 50px;
        }
        .detail {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            margin-top: 12px;
            word-break: break-word;
        }
    </style>
</head>
<body>
    <div class="error">
        <h2>OpenCode Assistant</h2>
        <p>Failed to load interface.</p>
        <p class="detail">${message}</p>
        <p><button onclick="acquireVsCodeApi().postMessage({ command: 'retry' })">Retry</button></p>
    </div>
</body>
</html>`
}

class OpenCodePanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView
  private readonly server: ServerManager
  private readonly output: vscode.OutputChannel

  constructor(server: ServerManager, output: vscode.OutputChannel) {
    this.server = server
    this.output = output
  }

  async resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    view.webview.options = { enableScripts: true }
    // The error page's Retry button posts a message here so the provider can
    // re-run the full render path (server start + session resolution) instead
    // of merely reloading the static error document.
    view.webview.onDidReceiveMessage((message) => {
      if (message?.command === "retry") void this.render(view.webview)
    })
    await this.render(view.webview)
  }

  async refresh() {
    if (!this.view) return
    await this.render(this.view.webview)
  }

  private async render(webview: vscode.Webview) {
    try {
      const workspacePath = await this.workspacePath()
      await this.server.start(workspacePath)
      const target = await this.server.resolveSessionURL(workspacePath)
      webview.html = htmlFor(target)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`Failed to open OpenCode panel: ${message}`)
      webview.html = errorHtml(message)
      vscode.window.showErrorMessage(`Failed to open OpenCode panel: ${message}`)
    }
  }

  private async workspacePath(): Promise<string> {
    const deadline = Date.now() + WORKSPACE_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (workspacePath) return workspacePath
      await delay(100)
    }

    throw new Error("Open a VS Code workspace folder before starting OpenCode")
  }
}

// --- activation ---------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("OpenCode Assistant")
  const server = new ServerManager(output)
  const provider = new OpenCodePanelProvider(server, output)

  context.subscriptions.push(
    server,
    vscode.window.registerWebviewViewProvider("opencode-v2.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("opencode-v2.openPanel", () => {
      output.appendLine("Opening OpenCode panel...")
      return vscode.commands.executeCommand(VIEW_CONTAINER)
    }),
    vscode.commands.registerCommand("opencode-v2.refreshPanel", () => {
      output.appendLine("Refreshing OpenCode panel...")
      return provider.refresh()
    }),
  )

  output.appendLine("OpenCode extension activated")
}
