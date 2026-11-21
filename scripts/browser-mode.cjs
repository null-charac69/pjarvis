const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const modes = {
  browser: { deployment: "browser", webPort: 5173 },
  pwa: { deployment: "pwa", webPort: 4173 },
};

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function profilePaths(name) {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable; a per-user data directory cannot be selected.");
  const configuredDataDirectory = process.env.JARVIS_DATA_DIR?.trim();
  if (configuredDataDirectory && !path.isAbsolute(configuredDataDirectory)) {
    throw new Error("JARVIS_DATA_DIR must be an absolute user-approved writable path.");
  }
  const runDirectory = path.join(localAppData, "JARVIS", "run");
  const projectKey = crypto.createHash("sha256").update(root).digest("hex").slice(0, 12);
  return {
    runDirectory,
    stateFile: path.join(runDirectory, `${name}-${projectKey}-mode.json`),
    dataDirectory: configuredDataDirectory
      ? path.resolve(configuredDataDirectory)
      : path.join(localAppData, "JARVIS", "data"),
  };
}

function assertWindows() {
  if (process.platform !== "win32") throw new Error("These scripts support the managed Windows deployment profile only.");
}

async function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(preferredPort) {
  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`No free loopback port was found in ${preferredPort}-${preferredPort + 19}.`);
}

function requestLoopback(url, { method = "GET", headers = {}, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers, agent: false, timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("timeout", () => request.destroy(new Error("Loopback request timed out.")));
    request.on("error", reject);
    request.end();
  });
}

async function waitFor(url, label, timeoutMs = 30_000, headers = {}) {
  const expiresAt = Date.now() + timeoutMs;
  let lastStatus = "not responding";
  while (Date.now() < expiresAt) {
    try {
      const response = await requestLoopback(url, { headers, timeoutMs: 1200 });
      if (response.status >= 200 && response.status < 300) return;
      lastStatus = `HTTP ${response.status}`;
    } catch {
      lastStatus = "not responding";
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${label} did not become healthy (${lastStatus}).`);
}

async function verifyBrowserApi(apiPort, origin) {
  const apiRoot = `http://127.0.0.1:${apiPort}/api/v1`;
  try {
    const bootstrap = await requestLoopback(`${apiRoot}/session/token`, {
      method: "POST",
      headers: { Origin: origin },
    });
    if (bootstrap.status !== 200) return { secure: false, healthStatus: bootstrap.status };
    const envelope = JSON.parse(bootstrap.body);
    const token = envelope?.data?.token;
    if (typeof token !== "string" || token.length < 40) return { secure: false, healthStatus: bootstrap.status };

    const [authenticated, missingSession, hostileOrigin, missingOrigin] = await Promise.all([
      requestLoopback(`${apiRoot}/health`, { headers: { Origin: origin, "X-Jarvis-Session-Token": token } }),
      requestLoopback(`${apiRoot}/health`, { headers: { Origin: origin } }),
      requestLoopback(`${apiRoot}/health`, { headers: { Origin: "https://attacker.invalid", "X-Jarvis-Session-Token": token } }),
      requestLoopback(`${apiRoot}/health`),
    ]);
    return {
      secure: authenticated.status === 200
        && missingSession.status === 401
        && hostileOrigin.status === 403
        && missingOrigin.status === 403,
      healthStatus: authenticated.status,
    };
  } catch {
    return { secure: false, healthStatus: "unavailable" };
  }
}

function startChild(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

function powershellCommandLine(pid) {
  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $p.CommandLine }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0) throw new Error("Could not verify an owned browser-mode process.");
  return result.stdout.trim();
}

function processIsOwned(record) {
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  const commandLine = powershellCommandLine(record.pid).toLowerCase();
  return commandLine.includes(root.toLowerCase())
    && commandLine.includes(record.signature.toLowerCase());
}

function stopOwned(record) {
  if (!processIsOwned(record)) return false;
  process.kill(record.pid);
  return true;
}

async function start(name, { openBrowser = false, component = "all" } = {}) {
  assertWindows();
  const mode = modes[name];
  if (!mode) throw new Error("Choose browser or pwa.");
  if (!["all", "backend", "renderer"].includes(component)) throw new Error("Choose all, backend, or renderer.");
  const paths = profilePaths(name);
  let previousState;
  if (fs.existsSync(paths.stateFile)) {
    previousState = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
    if (previousState.root !== root || previousState.mode !== name) throw new Error("Process record does not belong to this project and profile.");
    previousState.processes = previousState.processes.filter(processIsOwned);
    if (component === "all" && previousState.processes.length) throw new Error(`${name} mode is already running. Stop it before starting again.`);
    const componentProcessName = component === "backend" ? "api" : component === "renderer" ? "web" : undefined;
    if (componentProcessName && previousState.processes.some((record) => record.name === componentProcessName)) {
      throw new Error(`The ${component} process is already running.`);
    }
    if (!previousState.processes.length && component === "renderer") throw new Error("Start the backend before starting the renderer.");
    if (!previousState.processes.length) fs.rmSync(paths.stateFile, { force: true });
  } else if (component === "renderer") {
    throw new Error("Start the backend before starting the renderer.");
  }
  const otherMode = name === "browser" ? "pwa" : "browser";
  const otherStateFile = profilePaths(otherMode).stateFile;
  if (fs.existsSync(otherStateFile)) {
    const otherState = JSON.parse(fs.readFileSync(otherStateFile, "utf8"));
    if (otherState.root === root && otherState.processes.some(processIsOwned)) {
      throw new Error(`Stop ${otherMode} mode before starting ${name} mode; both profiles use the same local database.`);
    }
  }

  const apiPort = previousState?.apiPort ?? await findAvailablePort(8765);
  const webPort = previousState?.webPort ?? await findAvailablePort(mode.webPort);

  const python = path.join(root, ".venv", "Scripts", "python.exe");
  const vite = path.join(root, "apps", "desktop", "node_modules", "vite", "bin", "vite.js");
  const apiDirectory = path.join(root, "apps", "api");
  if (!fs.existsSync(python)) throw new Error("The project virtual-environment Python was not found. Create the repository's .venv first.");
  if (!fs.existsSync(vite)) throw new Error("Vite dependencies were not found. Install the existing desktop package dependencies first.");
  if (name === "pwa" && !fs.existsSync(path.join(root, "apps", "desktop", "src", "dist", "index.html"))) {
    throw new Error("The PWA build is missing. Run scripts/build-browser.ps1 first.");
  }

  fs.mkdirSync(paths.runDirectory, { recursive: true });
  fs.mkdirSync(paths.dataDirectory, { recursive: true });
  const origin = `http://127.0.0.1:${webPort}`;
  const backendEnv = {
    ...process.env,
    JARVIS_ENV: "production",
    JARVIS_DEPLOYMENT_MODE: mode.deployment,
    JARVIS_APP__ENVIRONMENT: "production",
    JARVIS_DEPLOYMENT__MODE: mode.deployment,
    JARVIS_DATA_DIR: paths.dataDirectory,
    JARVIS_ALLOWED_ORIGINS: origin,
    JARVIS_SERVER__ALLOWED_ORIGINS: JSON.stringify([origin]),
    JARVIS_SERVER__HOST: "127.0.0.1",
    JARVIS_SERVER__PORT: String(apiPort),
    JARVIS_BROWSER_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
  };
  const frontendEnv = {
    ...process.env,
    JARVIS_BROWSER_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
  };
  const frontendArgs = name === "browser"
    ? [vite, "--mode", "browser", "--config", "vite.renderer.config.ts", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"]
    : [vite, "preview", "--config", "vite.renderer.config.ts", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"];
  const processes = previousState?.processes ?? [];
  const originalProcesses = [...processes];
  const newlyStarted = [];
  const dataDirectory = previousState?.dataDirectory ?? paths.dataDirectory;
  const state = { mode: name, root, origin, apiPort, webPort, dataDirectory, startedAt: previousState?.startedAt ?? new Date().toISOString(), processes };
  const saveState = () => fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2));

  try {
    if ((component === "all" || component === "backend") && !processes.some((record) => record.name === "api")) {
      const api = startChild(python, ["-m", "uvicorn", "app.main:app", "--app-dir", apiDirectory, "--host", "127.0.0.1", "--port", String(apiPort), "--no-proxy-headers", "--ws-max-size", "2048"], apiDirectory, backendEnv);
      const record = { name: "api", pid: api.pid, signature: "uvicorn app.main:app" };
      processes.push(record);
      newlyStarted.push(record);
      saveState();
      await waitFor(`http://127.0.0.1:${apiPort}/api/v1/health/live`, "Local API", 30_000, { Origin: origin });
      const apiCheck = await verifyBrowserApi(apiPort, origin);
      if (!apiCheck.secure) throw new Error("The local API did not enforce browser session and exact-Origin controls; renderer startup was cancelled.");
    }

    if (component === "all" || component === "renderer") {
      if (!processes.some((record) => record.name === "api")) throw new Error("The local API is not running. Start the backend first.");
      const web = startChild(process.execPath, frontendArgs, path.join(root, "apps", "desktop"), frontendEnv);
      const record = { name: "web", pid: web.pid, signature: "vite.js" };
      processes.push(record);
      newlyStarted.push(record);
      saveState();
      await waitFor(origin, "Browser application");
    }

    if (component === "all" || component === "renderer") console.log(`${name} mode is ready at ${origin}`);
    else console.log(`Local API is ready at http://127.0.0.1:${apiPort}`);
    console.log(`User data directory: ${dataDirectory}`);
    if (openBrowser) {
      const browser = spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${origin}"`], {
        stdio: "ignore",
        windowsHide: true,
      });
      browser.unref();
    }
  } catch (error) {
    for (const record of newlyStarted.reverse()) {
      try { stopOwned(record); } catch { /* Preserve the startup failure. */ }
    }
    state.processes = originalProcesses;
    if (originalProcesses.length) saveState();
    else fs.rmSync(paths.stateFile, { force: true });
    throw error;
  }
}

async function stop(name) {
  assertWindows();
  const paths = profilePaths(name);
  if (!fs.existsSync(paths.stateFile)) {
    console.log(`${name} mode has no owned process record.`);
    return;
  }
  const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
  if (state.root !== root || state.mode !== name) throw new Error("Process record does not belong to this project and profile.");
  for (const record of state.processes.reverse()) {
    if (stopOwned(record)) console.log(`Stopped owned ${record.name} process.`);
  }
  fs.rmSync(paths.stateFile, { force: true });
}

async function status(name) {
  const mode = modes[name];
  if (!mode) throw new Error("Choose browser or pwa.");
  const paths = profilePaths(name);
  const state = fs.existsSync(paths.stateFile)
    ? JSON.parse(fs.readFileSync(paths.stateFile, "utf8"))
    : undefined;
  const ownedState = state?.root === root && state?.mode === name ? state : undefined;
  const origin = ownedState?.origin ?? `http://127.0.0.1:${mode.webPort}`;
  const apiPort = ownedState?.apiPort ?? 8765;
  try {
    await waitFor(origin, "Browser application", 1500);
    const apiCheck = await verifyBrowserApi(apiPort, origin);
    console.log(`${name} frontend: ${origin}`);
    console.log(`Local API: HTTP ${apiCheck.healthStatus}`);
    console.log(`Browser session and Origin controls: ${apiCheck.secure ? "verified" : "FAILED"}`);
  } catch {
    console.log(`${name} mode is not fully healthy at ${origin}.`);
  }
  if (ownedState) {
    const owned = ownedState.processes.filter(processIsOwned).map((process) => process.name);
    console.log(`Owned processes: ${owned.length ? owned.join(", ") : "none running"}`);
    console.log(`Started: ${ownedState.startedAt}`);
  }
  console.log(`User data directory: ${ownedState?.dataDirectory ?? paths.dataDirectory}`);
}

async function main() {
  const [action, name, option] = process.argv.slice(2);
  if (action === "start") return start(name, {
    openBrowser: option === "--open",
    component: option === "--backend" ? "backend" : option === "--renderer" ? "renderer" : "all",
  });
  if (action === "stop") return stop(name);
  if (action === "status") return status(name);
  throw new Error("Usage: browser-mode.cjs <start|stop|status> <browser|pwa>");
}

main().catch((error) => fail(error instanceof Error ? error.message : "Browser deployment operation failed."));