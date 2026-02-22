@echo off
set FFMPEG_PATH=%~dp0ffmpeg\ffmpeg.exe
set PATH=%~dp0node;%PATH%
cd /d "%~dp0"
node main.js
pause
