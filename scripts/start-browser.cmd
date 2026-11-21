@echo off
setlocal
pushd "%~dp0\.."
node scripts\browser-mode.cjs start browser --open
set "JARVIS_EXIT=%ERRORLEVEL%"
popd
exit /b %JARVIS_EXIT%