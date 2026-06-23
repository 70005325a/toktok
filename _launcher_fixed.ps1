# 톡톡 메신저 고정 주소 실행기 (톡톡_고정주소.bat 가 호출)
$ErrorActionPreference = "SilentlyContinue"
chcp 65001 > $null
Set-Location $PSScriptRoot
$env:PYTHONIOENCODING = "utf-8"

function Stop-Toktok {
    Get-CimInstance Win32_Process -Filter "name='python.exe'" | Where-Object { $_.CommandLine -like '*server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
}

Write-Host "=================================================="
Write-Host "   💬 톡톡 메신저 - 고정 주소로 실행"
Write-Host "=================================================="

if (-not (Test-Path "ngrok_domain.txt")) {
    Write-Host ""
    Write-Host "  ❌ 아직 고정 주소 설정이 안 됐어요."
    Write-Host "     먼저 '고정주소_설정.bat' 을 한 번 실행하세요."
    Read-Host "`nEnter 를 누르면 닫힙니다"
    exit
}
$domain = (Get-Content "ngrok_domain.txt" -Raw).Trim()
if (-not $domain) { Write-Host "  ❌ 도메인이 비어 있어요. '고정주소_설정.bat' 을 다시 실행하세요."; Read-Host; exit }
$publicUrl = "https://$domain"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "  ❌ Python 이 필요합니다. https://www.python.org 에서 설치 후 다시 실행하세요."
    Read-Host "`nEnter 를 누르면 닫힙니다"
    exit
}

$code = Read-Host "입장 비밀번호 (없으면 그냥 Enter)"
$env:ACCESS_CODE = $code

Write-Host ""
Write-Host "기존 서버/터널 정리 중..."
Stop-Toktok
Start-Sleep -Milliseconds 800

Write-Host "[1/2] 메신저 서버 시작..."
$server = Start-Process python -ArgumentList "server.py" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$ok = $false
try { Invoke-WebRequest http://localhost:4173/config -UseBasicParsing -TimeoutSec 5 | Out-Null; $ok = $true } catch { }
if (-not $ok) {
    Write-Host "  ❌ 서버 시작 실패 (포트 4173 사용 중일 수 있어요)."
    Read-Host "`nEnter"
    Stop-Toktok
    exit
}
Write-Host "      서버 OK"

Write-Host "[2/2] 고정 주소 터널 연결... ($publicUrl)"
$ngrok = Start-Process ".\ngrok.exe" -ArgumentList "http", "--url=$domain", "4173" -PassThru -WindowStyle Hidden

# 고정 주소가 실제 응답할 때까지 대기
$live = $false
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline -and -not $live) {
    Start-Sleep -Milliseconds 1500
    try { Invoke-WebRequest "$publicUrl/config" -UseBasicParsing -TimeoutSec 5 | Out-Null; $live = $true } catch { }
}

Clear-Host
Write-Host "=================================================="
if ($live) {
    Set-Clipboard -Value $publicUrl
    Write-Host ""
    Write-Host "   ✅ 준비 완료! 항상 같은 주소입니다:"
    Write-Host ""
    Write-Host "   $publicUrl"
    Write-Host ""
    Write-Host "   📋 클립보드에 복사됨 (카톡 등에 Ctrl+V)"
    if ($code) { Write-Host "   🔒 입장 비밀번호: $code" }
} else {
    Write-Host "   ⚠️ 주소 연결 확인 실패."
    Write-Host "   - authtoken/도메인이 맞는지 확인 ('고정주소_설정.bat' 다시 실행)"
    Write-Host "   - 도메인 철자: $domain"
}
Write-Host ""
Write-Host "=================================================="
Write-Host "   ※ 이 창을 켜 둔 동안 접속 가능. 끝내려면 Enter."
Write-Host "=================================================="

Read-Host "`n종료하려면 Enter"
Write-Host "정리 중..."
Stop-Toktok
