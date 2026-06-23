# 톡톡 메신저 원클릭 실행기 (톡톡_시작.bat 가 호출)
$ErrorActionPreference = "SilentlyContinue"
chcp 65001 > $null
Set-Location $PSScriptRoot
$env:PYTHONIOENCODING = "utf-8"

function Stop-Toktok {
    Get-CimInstance Win32_Process -Filter "name='python.exe'" | Where-Object { $_.CommandLine -like '*server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
}

Write-Host "=================================================="
Write-Host "   💬 톡톡 메신저 - 외부 공개 실행기"
Write-Host "=================================================="
Write-Host ""

# Python 확인
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "  ❌ Python 이 설치되어 있지 않습니다. https://nodejs.org 가 아니라"
    Write-Host "     https://www.python.org 에서 Python 을 설치한 뒤 다시 실행하세요."
    Read-Host "`nEnter 를 누르면 닫힙니다"
    exit
}

$code = Read-Host "입장 비밀번호를 정하세요 (없으면 그냥 Enter)"
$env:ACCESS_CODE = $code

Write-Host ""
Write-Host "기존에 켜져 있던 서버/터널을 정리합니다..."
Stop-Toktok
Start-Sleep -Milliseconds 800

Write-Host "[1/2] 메신저 서버 시작 중..."
$server = Start-Process python -ArgumentList "server.py" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$ok = $false
try { Invoke-WebRequest http://localhost:4173/config -UseBasicParsing -TimeoutSec 5 | Out-Null; $ok = $true } catch { }
if (-not $ok) {
    Write-Host "  ❌ 서버를 시작하지 못했습니다. (포트 4173 사용 중이거나 server.py 문제)"
    Read-Host "`nEnter 를 누르면 닫힙니다"
    Stop-Toktok
    exit
}
Write-Host "      서버 OK (localhost:4173)"

Write-Host "[2/2] 외부 공개 터널 연결 중... (10~25초 걸려요)"
Remove-Item tunnel.log, tunnel.out -ErrorAction SilentlyContinue
$tunnel = Start-Process ".\cloudflared.exe" -ArgumentList "tunnel", "--url", "http://localhost:4173" -PassThru -WindowStyle Hidden -RedirectStandardError "tunnel.log" -RedirectStandardOutput "tunnel.out"

$url = $null
$deadline = (Get-Date).AddSeconds(35)
while ((Get-Date) -lt $deadline -and -not $url) {
    Start-Sleep -Milliseconds 1000
    foreach ($f in @("tunnel.log", "tunnel.out")) {
        if (Test-Path $f) {
            $t = Get-Content $f -Raw
            if ($t -match "https://[a-z0-9-]+\.trycloudflare\.com") { $url = $matches[0]; break }
        }
    }
}

Clear-Host
Write-Host "=================================================="
if ($url) {
    Set-Clipboard -Value $url
    Write-Host ""
    Write-Host "   ✅ 준비 완료! 아래 주소를 친구에게 보내세요"
    Write-Host ""
    Write-Host "   $url"
    Write-Host ""
    Write-Host "   📋 위 주소가 클립보드에 복사됐어요 (카톡 등에 Ctrl+V)"
    if ($code) { Write-Host "   🔒 입장 비밀번호: $code  (친구에게 같이 알려주세요)" }
} else {
    Write-Host "   ⚠️ 공개 주소를 받지 못했어요. 인터넷/방화벽을 확인하고 다시 실행하세요."
}
Write-Host ""
Write-Host "=================================================="
Write-Host "   ※ 이 창을 켜 둔 동안에만 친구가 접속할 수 있어요."
Write-Host "   ※ 끝내려면 이 창에서 Enter 를 누르세요."
Write-Host "=================================================="

Read-Host "`n종료하려면 Enter"
Write-Host "정리 중..."
Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
Stop-Toktok
