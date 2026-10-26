@echo off
chcp 65001 >nul
title CC Switch / Codex 过滤层 - 环境检查
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0检查运行环境.ps1"
echo.
pause
