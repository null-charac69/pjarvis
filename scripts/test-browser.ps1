$ErrorActionPreference = "Stop"
uv run pytest tests/test_settings.py tests/test_browser_security.py tests/test_websocket_api.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm --prefix "$PSScriptRoot\..\apps\desktop" test
exit $LASTEXITCODE