# WSL Setup

## Status

WSL can run the backend, desktop renderer, and automated validation. Windows remains the target for Electron runtime, Windows packaging, native audio devices, microphone permissions, and system controls. Do not treat a WSL renderer build as an installed Windows application test.

## Prerequisites

Use a supported WSL distribution and install Git, Python 3.12, uv, and Node.js 22.12+ inside the Linux environment. The desktop uses npm and its committed `package-lock.json`; pnpm is not used. Keep the working tree in the WSL filesystem; do not mix Windows and Linux virtual environments or `node_modules` directories.

Verify in the WSL shell:

```bash
python3.12 --version
node --version
npm --version
git --version
uv --version
```

From the repository root, install dependencies and start the API:

```bash
uv sync --group dev
uv run uvicorn app.main:app --app-dir apps/api --host localhost --port 8765
```

Check the backend health endpoint at `http://localhost:8765/api/v1/health`. WSL networking/forwarding may affect Windows-to-WSL access; the backend does not expose itself to the LAN by default.

If preparing configuration, copy the template from the repository root:

```bash
cp .env.example .env
```

`.env` is ignored by Git. Its empty placeholders do not configure a live provider. Do not store secrets in renderer/browser storage or commit local configuration.

## WSL Limits

Do not assume a Linux backend can access Windows microphone, clipboard, Explorer, applications, or system metrics with the same permissions as a Windows-native process. Later implementation must expose these capabilities through explicit adapters and permission checks; unavailable integrations must report unavailable rather than fabricate success.

Run `bash scripts/validate-wsl.sh` for backend and renderer/toolchain checks after installing locked dependencies. Windows installer packaging and Electron runtime smoke tests must still be performed on a Windows host with the Electron binary available. See [ARCHITECTURE.md](ARCHITECTURE.md), [PROVIDER_SETUP.md](PROVIDER_SETUP.md), and [release readiness](docs/RELEASE_READINESS.md).