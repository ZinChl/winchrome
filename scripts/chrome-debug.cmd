@echo off
title Chrome Debug Toggle
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0chrome-debug.ps1" toggle
ping -n 3 127.0.0.1 >nul
