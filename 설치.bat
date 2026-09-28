@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 영상 자동편집 - 설치
echo ============================================================
echo    영상 자동편집 - 설치  (처음 한 번만 실행하면 됩니다)
echo ============================================================
echo.

rem ---- 1. Python 확인 (3.10 ~ 3.12) ----
set "PY="
py -3.11 --version >nul 2>&1 && set "PY=py -3.11"
if not defined PY py -3.12 --version >nul 2>&1 && set "PY=py -3.12"
if not defined PY py -3.10 --version >nul 2>&1 && set "PY=py -3.10"
if not defined PY goto :no_python
echo [1/5] Python 확인 완료
%PY% --version

rem ---- 2. ffmpeg 확인 ----
where ffmpeg >nul 2>&1 || goto :no_ffmpeg
where ffprobe >nul 2>&1 || goto :no_ffmpeg
echo [2/5] ffmpeg 확인 완료

rem ---- 3. 프로그램 전용 Python 환경 + 패키지 ----
if not exist ".venv\Scripts\python.exe" %PY% -m venv .venv || goto :fail
echo [3/5] 필요한 파이썬 패키지를 설치합니다. 몇 분 걸릴 수 있습니다...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet || goto :fail
".venv\Scripts\python.exe" -m pip install -r requirements.txt --quiet || goto :fail
echo       패키지 설치 완료

rem ---- 4. 음성인식 모델 (약 1.6GB) ----
echo [4/5] 음성인식 모델 준비
".venv\Scripts\python.exe" -m backend.setup_model || goto :fail

rem ---- 5. 화면 파일 (이미 만들어져 있으면 건너뜀) ----
if exist "frontend\dist\index.html" goto :frontend_ok
where npm >nul 2>&1 || goto :no_node
echo [5/5] 화면 파일을 만듭니다...
pushd frontend
call npm install --no-audit --no-fund || (popd & goto :fail)
call npm run build || (popd & goto :fail)
popd
:frontend_ok
echo [5/5] 화면 파일 확인 완료

echo.
echo ============================================================
echo    설치 완료!  이제 "실행.bat"을 더블클릭하세요.
echo ============================================================
echo.
choice /c YN /m "컴퓨터를 켤 때 서버가 자동으로 켜지게 할까요? Y=예, N=아니오"
if errorlevel 2 goto :end
".venv\Scripts\python.exe" -m backend.autostart on
goto :end

:no_python
echo [오류] Python 3.11 이 설치되어 있지 않습니다.
echo   1. https://www.python.org/downloads/release/python-3119/ 접속
echo   2. 맨 아래 "Windows installer 64-bit" 내려받아 실행
echo   3. 첫 화면에서 "Add python.exe to PATH" 체크 후 Install Now
echo   4. 설치가 끝나면 이 설치.bat 을 다시 실행하세요.
goto :end

:no_ffmpeg
echo [오류] ffmpeg 를 찾을 수 없습니다.
echo   시작 메뉴에서 "명령 프롬프트"를 열고 아래 한 줄을 입력한 뒤 Enter:
echo       winget install Gyan.FFmpeg
echo   설치가 끝나면 명령 프롬프트를 닫고 이 설치.bat 을 다시 실행하세요.
goto :end

:no_node
echo [오류] 화면 파일(frontend\dist)이 없고 Node.js 도 없습니다.
echo   https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
goto :end

:fail
echo.
echo [오류] 설치 중 문제가 생겼습니다. 위의 메시지를 캡처해서 담당자에게 보내주세요.

:end
echo.
pause
