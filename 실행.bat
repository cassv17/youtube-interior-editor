@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" goto :no_install
start "" ".venv\Scripts\pythonw.exe" "backend\run_server.py" --open
echo 잠시 후 브라우저에서 http://localhost:8000 이 열립니다.
echo 이 창은 닫아도 됩니다. 프로그램은 백그라운드에서 계속 실행됩니다.
timeout /t 4 >nul
exit /b 0

:no_install
echo 먼저 "설치.bat"을 실행하세요.
pause
