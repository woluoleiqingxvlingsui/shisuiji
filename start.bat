@echo off
rem shisuiji graphical console (compat entry). Primary entry: launch.vbs / desktop shortcut.
rem This bat flashes a console briefly; use launch.vbs for a completely windowless launch.
rem Node.js is not required: the portable package ships its own runtime (runtime\node.exe).
cd /d "%~dp0"
where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell was not found. Windows 10/11 include it; please use launch.vbs instead.
  pause
  exit /b 1
)
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0control-ui.ps1"
