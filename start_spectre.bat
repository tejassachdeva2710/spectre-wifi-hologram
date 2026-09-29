@echo off
title SPECTRE Passive Wi-Fi Holography System
cd /d "%~dp0"

echo ===============================================================
echo   SPECTRE -- PASSIVE WI-FI HOLOGRAPHY CONSOLE
echo   Initializing Python RF Telemetry Backend + Vite Frontend
echo ===============================================================

echo [1/3] Starting Python Native Wi-Fi Backend on http://127.0.0.1:8765...
start "SPECTRE Backend" /min python backend\server.py

echo [2/3] Starting Vite Frontend on http://localhost:5173...
start "SPECTRE Frontend" /min cmd.exe /c "npm run dev"

echo [3/3] Waiting for services to bind...
timeout /t 3 /nobreak >nul

echo Opening SPECTRE Console in Chrome...
if exist "%USERPROFILE%\open_url.bat" (
    call "%USERPROFILE%\open_url.bat" "http://localhost:5173"
) else (
    start http://localhost:5173
)

echo.
echo ===============================================================
echo   SPECTRE is running!
echo   Backend:  http://127.0.0.1:8765
echo   Frontend: http://localhost:5173
echo ===============================================================
