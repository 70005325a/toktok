@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 톡톡 메신저 - 외부 공개

echo ============================================================
echo   💬 톡톡 메신저 : 인터넷 외부 공개 모드
echo ============================================================
echo.
set /p ACCESS_CODE="입장 비밀번호를 정하세요 (없으면 그냥 엔터): "
echo.
echo  [1/2] 메신저 서버를 시작합니다...
start "톡톡 서버" cmd /c "chcp 65001 >nul & set ACCESS_CODE=%ACCESS_CODE% & python server.py"

echo  [2/2] 외부 공개 터널을 연결합니다... (잠시 기다려 주세요)
echo.
echo  ▼ 아래 박스 안에 표시되는 https://....trycloudflare.com 주소를
echo    상대방에게 보내면, 인터넷 어디서나 접속할 수 있습니다.
echo.
echo  ※ 이 창을 닫으면 외부 접속이 끊깁니다. (계속 켜 두세요)
echo  ※ 무료 터널은 켤 때마다 주소가 바뀝니다.
echo ============================================================
echo.

cloudflared.exe tunnel --url http://localhost:4173

echo.
echo 터널이 종료되었습니다. 아무 키나 누르면 창이 닫힙니다.
pause >nul
