@echo off
chcp 65001 >nul
title 思辨与信仰 · 一键发布
cd /d "%~dp0"
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\publish.ps1"
echo.
echo 按任意键关闭窗口...
pause >nul
