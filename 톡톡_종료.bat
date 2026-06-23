@echo off
chcp 65001 >nul
echo 톡톡 메신저 서버와 터널을 종료합니다...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | Where-Object { $_.CommandLine -like '*server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force"
echo 종료 완료.
timeout /t 2 >nul
