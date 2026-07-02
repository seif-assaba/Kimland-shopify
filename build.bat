@echo off
title Building Kimland Shopify Sync
color 0A

echo ========================================
echo   🚀 Building Kimland Shopify Sync
echo ========================================
echo.

:: Check Node.js
echo [1/5] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Node.js not found! Please install Node.js.
    pause
    exit /b 1
)
echo ✅ Node.js found

:: Install dependencies
echo [2/5] Installing dependencies...
call npm install
echo ✅ Dependencies installed

:: Install Playwright
echo [3/5] Installing Playwright...
call npx playwright install
echo ✅ Playwright installed

:: Build with pkg
echo [4/5] Building executable...
if not exist dist mkdir dist
call pkg . --targets node18-win-x64 --output dist/kimland-sync.exe
echo ✅ Executable built

:: Build with electron
echo [5/5] Building installer...
call npm run build:win
echo ✅ Installer built

echo.
echo ========================================
echo   ✅ Build Complete!
echo   📁 dist\Kimland Shopify Sync Setup.exe
echo ========================================
echo.
echo To distribute to your client:
echo 1. Copy dist\Kimland Shopify Sync Setup.exe
echo 2. Send it to your client
echo 3. Client runs the installer
echo.

pause