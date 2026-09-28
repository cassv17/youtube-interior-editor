@echo off
chcp 65001 >nul
rem 백그라운드에서 실행 중인 서버(포트 8000)를 끈다. 진행 중인 분석·내보내기도 멈춘다.
set "PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:8000 .*LISTENING"') do set "PID=%%p"
if not defined PID (
  echo 실행 중인 서버가 없습니다.
) else (
  taskkill /PID %PID% /F >nul && echo 서버를 껐습니다.
)
timeout /t 3 >nul
