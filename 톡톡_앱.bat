@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 톡톡 메신저 앱

REM 서버가 떠 있지 않으면 시작
powershell -NoProfile -Command "try{ Invoke-WebRequest http://localhost:4173/config -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 }catch{ exit 1 }"
if errorlevel 1 (
  echo 메신저 서버를 시작합니다...
  start "톡톡 서버" /min cmd /c "chcp 65001 >nul & python server.py"
  powershell -NoProfile -Command "for($i=0;$i -lt 20;$i++){ try{ Invoke-WebRequest http://localhost:4173/config -UseBasicParsing -TimeoutSec 1 | Out-Null; exit 0 }catch{ Start-Sleep -Milliseconds 500 } }"
)

REM 주소창 없는 '앱 창'으로 열기 (Edge -> Chrome -> 기본 브라우저)
set "EDGE1=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "EDGE2=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "CH1=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CH2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%EDGE1%" ( start "" "%EDGE1%" --app=http://localhost:4173 & goto done )
if exist "%EDGE2%" ( start "" "%EDGE2%" --app=http://localhost:4173 & goto done )
if exist "%CH1%"   ( start "" "%CH1%"   --app=http://localhost:4173 & goto done )
if exist "%CH2%"   ( start "" "%CH2%"   --app=http://localhost:4173 & goto done )
start "" http://localhost:4173
:done
exit
