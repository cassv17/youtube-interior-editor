"""윈도우 로그인(부팅) 시 서버 자동 실행을 켜고 끈다.

사용자 '시작프로그램' 폴더에 바로가기 하나를 만들거나 지운다. 관리자 권한이나 레지스트리는 쓰지 않는다.
  python -m backend.autostart on         서버만 자동 실행 (브라우저는 필요할 때 직접 접속)
  python -m backend.autostart on --open  서버 자동 실행 + 브라우저도 자동으로 열기
  python -m backend.autostart off        자동 실행 해제
  python -m backend.autostart status     현재 상태
"""
import base64
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHONW = ROOT / ".venv" / "Scripts" / "pythonw.exe"
SCRIPT = ROOT / "backend" / "run_server.py"
LINK_NAME = "영상 자동편집 서버.lnk"


def startup_dir() -> Path:
    return Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def _ps(script: str) -> None:
    # 한글 경로가 깨지지 않도록 명령을 UTF-16으로 인코딩해 넘긴다
    enc = base64.b64encode(script.encode("utf-16-le")).decode()
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], check=True)


def _q(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def on(open_browser: bool) -> Path:
    if not PYTHONW.is_file():
        raise SystemExit("먼저 설치.bat을 실행하세요 (.venv가 없습니다).")
    link = startup_dir() / LINK_NAME
    args = f'"{SCRIPT}"' + (" --open" if open_browser else "")
    _ps(
        f"$s = (New-Object -ComObject WScript.Shell).CreateShortcut({_q(str(link))});"
        f"$s.TargetPath = {_q(str(PYTHONW))};"
        f"$s.Arguments = {_q(args)};"
        f"$s.WorkingDirectory = {_q(str(ROOT))};"
        f"$s.Description = {_q('영상 자동편집 로컬 서버 (http://localhost:8000)')};"
        "$s.WindowStyle = 7;"
        "$s.Save()"
    )
    return link


def off() -> bool:
    link = startup_dir() / LINK_NAME
    if link.exists():
        link.unlink()
        return True
    return False


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "on":
        link = on("--open" in sys.argv)
        print(f"자동 실행을 켰습니다. 다음 로그인부터 서버가 자동으로 켜집니다.\n  {link}")
    elif cmd == "off":
        print("자동 실행을 껐습니다." if off() else "자동 실행이 이미 꺼져 있습니다.")
    else:
        link = startup_dir() / LINK_NAME
        print(f"자동 실행: {'켜짐' if link.exists() else '꺼짐'}  ({link})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
