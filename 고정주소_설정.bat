@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 톡톡 고정주소 1회 설정

echo ==================================================
echo    톡톡 메신저 - 고정(영구) 주소 1회 설정
echo ==================================================
echo.
echo  아래 3가지를 브라우저에서 먼저 하세요(무료):
echo.
echo   1) 가입:   https://dashboard.ngrok.com/signup
echo   2) 토큰:   https://dashboard.ngrok.com/get-started/your-authtoken
echo              (Your Authtoken 의 긴 문자열 복사)
echo   3) 도메인: https://dashboard.ngrok.com/domains
echo              ( + New Domain  눌러 무료 도메인 발급, 예: happy-cat-1234.ngrok-free.app )
echo.
echo ==================================================
echo.
set /p TOKEN=2번 authtoken 을 붙여넣고 Enter ^(마우스 우클릭=붙여넣기^):
if not "%TOKEN%"=="" ( ngrok.exe config add-authtoken %TOKEN% )
echo.
set /p DOMAIN=3번 도메인을 입력하고 Enter (예: happy-cat-1234.ngrok-free.app):
if "%DOMAIN%"=="" ( echo 도메인이 비었습니다. 다시 실행하세요. & pause & exit )

> ngrok_domain.txt echo %DOMAIN%

REM 더블클릭하면 고정주소로 바로 열리는 바로가기(.url) 생성
> "톡톡_열기.url" (
  echo [InternetShortcut]
  echo URL=https://%DOMAIN%
)

echo.
echo ==================================================
echo  ✅ 설정 완료!
echo     고정 주소: https://%DOMAIN%
echo.
echo  - 앞으로 "톡톡_고정주소.bat" 더블클릭하면 항상 이 주소로 열립니다.
echo  - "톡톡_열기.url" 을 바탕화면에 두면 더블클릭으로 바로 접속.
echo ==================================================
pause
