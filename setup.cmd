@echo off
setlocal enabledelayedexpansion

echo ============================================
echo   EufyView - First-Time Setup
echo ============================================
echo.

set "ROOT=%~dp0"
set "NODE_DIR=%ROOT%node"
set "FFMPEG_DIR=%ROOT%ffmpeg"
set "TEMP_DIR=%ROOT%_setup_temp"

:: ---- Node.js v22.13.1 ----
if exist "%NODE_DIR%\node.exe" (
    echo [OK] Node.js already installed
) else (
    echo [1/2] Downloading Node.js v22.13.1...
    mkdir "%TEMP_DIR%" 2>nul
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.13.1/node-v22.13.1-win-x64.zip' -OutFile '%TEMP_DIR%\node.zip'"
    if !errorlevel! neq 0 (
        echo ERROR: Failed to download Node.js
        goto :cleanup
    )
    echo        Extracting...
    powershell -NoProfile -Command "Expand-Archive -Path '%TEMP_DIR%\node.zip' -DestinationPath '%TEMP_DIR%' -Force"
    mkdir "%NODE_DIR%" 2>nul
    xcopy "%TEMP_DIR%\node-v22.13.1-win-x64\*" "%NODE_DIR%\" /E /Q /Y >nul
    echo [OK] Node.js installed
)

:: ---- FFmpeg (gyan.dev essentials build) ----
if exist "%FFMPEG_DIR%\ffmpeg.exe" (
    echo [OK] FFmpeg already installed
) else (
    echo [2/2] Downloading FFmpeg...
    mkdir "%TEMP_DIR%" 2>nul
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile '%TEMP_DIR%\ffmpeg.zip'"
    if !errorlevel! neq 0 (
        echo ERROR: Failed to download FFmpeg
        goto :cleanup
    )
    echo        Extracting...
    powershell -NoProfile -Command "Expand-Archive -Path '%TEMP_DIR%\ffmpeg.zip' -DestinationPath '%TEMP_DIR%\ffmpeg_extract' -Force"
    mkdir "%FFMPEG_DIR%" 2>nul
    :: The zip contains a versioned folder like ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe
    for /d %%D in ("%TEMP_DIR%\ffmpeg_extract\ffmpeg-*") do (
        xcopy "%%D\bin\ffmpeg.exe" "%FFMPEG_DIR%\" /Q /Y >nul
        xcopy "%%D\bin\ffprobe.exe" "%FFMPEG_DIR%\" /Q /Y >nul
    )
    echo [OK] FFmpeg installed
)

:: ---- npm install ----
echo.
echo Installing npm dependencies...
set "PATH=%NODE_DIR%;%PATH%"
cd /d "%ROOT%"
call "%NODE_DIR%\npm.cmd" install
if !errorlevel! neq 0 (
    echo ERROR: npm install failed
    goto :cleanup
)
echo [OK] Dependencies installed

:cleanup
if exist "%TEMP_DIR%" (
    echo.
    echo Cleaning up temp files...
    rmdir /S /Q "%TEMP_DIR%"
)

echo.
echo ============================================
echo   Setup complete! Run start.cmd to launch.
echo ============================================
pause
