@echo off
rem shiji graphical console (compat entry). Primary entry: launch.vbs / desktop shortcut.
rem This bat flashes a console briefly; use launch.vbs for a completely windowless launch.
cd /d "%~dp0"
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0control-ui.ps1"
