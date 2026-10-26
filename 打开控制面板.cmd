@echo off
rem Opens the web control panel (starts it in the background if needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ccswitch-filter.ps1" Panel
if errorlevel 1 pause
