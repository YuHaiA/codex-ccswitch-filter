@echo off
rem Double-click to open the filter control menu. Optional arg: Start/Stop/Restart/Status
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=Menu"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ccswitch-filter.ps1" %ACTION%
if not "%~1"=="" pause
