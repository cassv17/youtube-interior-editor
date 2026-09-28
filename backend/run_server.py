"""서버 실행기. 실행.bat과 부팅 시 자동 실행이 이 파일을 창 없이(pythonw) 실행한다.

- 이미 켜져 있으면 새로 켜지 않는다(중복 실행 방지).
- --open: 서버가 준비되면 브라우저로 http://localhost:8000 을 연다.
- 창이 없으므로 모든 출력은 workspace/server.log 에 남긴다.
"""
import os
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOST, PORT = "127.0.0.1", 8000
URL = f"http://localhost:{PORT}"


def is_running() -> bool:
    try:
        with urllib.request.urlopen(f"{URL}/api/projects", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def open_when_ready() -> None:
    for _ in range(120):  # 최대 60초 대기
        if is_running():
            webbrowser.open(URL)
            return
        time.sleep(0.5)


def main() -> None:
    want_open = "--open" in sys.argv
    if is_running():
        if want_open:
            webbrowser.open(URL)
        return

    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    log_dir = ROOT / "workspace"
    log_dir.mkdir(exist_ok=True)
    log = open(log_dir / "server.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = log  # pythonw에는 콘솔이 없으므로 로그 파일로 보낸다
    print(f"\n===== 서버 시작 {time.strftime('%Y-%m-%d %H:%M:%S')} =====")

    if want_open:
        threading.Thread(target=open_when_ready, daemon=True).start()

    import uvicorn
    from backend.server import app

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
