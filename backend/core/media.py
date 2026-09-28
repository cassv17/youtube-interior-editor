"""ffmpeg/ffprobe 호출 도우미. 원본 파일은 읽기만 한다."""
import json
import os
import shutil
import subprocess
from pathlib import Path

# 창 없이 실행된 서버에서 ffmpeg를 부를 때 검은 콘솔 창이 번쩍이지 않게 한다(윈도우 전용 옵션)
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class MediaError(RuntimeError):
    pass


def _tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise MediaError(f"{name}을(를) 찾을 수 없습니다. ffmpeg 설치와 PATH 설정을 확인하세요.")
    return path


def ffmpeg() -> str:
    return _tool("ffmpeg")


def ffprobe() -> str:
    return _tool("ffprobe")


def run(args: list[str], **kw) -> subprocess.CompletedProcess:
    """외부 명령 실행. 실패하면 stderr 끝부분을 담아 MediaError를 낸다."""
    proc = subprocess.run(args, capture_output=True, creationflags=NO_WINDOW, **kw)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace") if isinstance(proc.stderr, bytes) else proc.stderr
        raise MediaError(f"명령 실패 ({Path(args[0]).name}): {err[-800:]}")
    return proc


def _fps(rate: str) -> float:
    num, _, den = rate.partition("/")
    return float(num) / float(den) if den and float(den) else float(num or 0)


def probe(path: str | Path) -> dict:
    """영상 정보: 길이, 표시 해상도(회전 반영), fps, 코덱, 회전값."""
    path = Path(path)
    if not path.is_file():
        raise MediaError(f"파일이 없습니다: {path}")
    out = run([
        ffprobe(), "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]).stdout
    info = json.loads(out.decode("utf-8", "replace"))
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    audio = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    if video is None:
        raise MediaError(f"영상 스트림이 없습니다: {path.name}")

    rotation = 0
    for sd in video.get("side_data_list", []):
        if "rotation" in sd:
            rotation = int(round(float(sd["rotation"]))) % 360
    width, height = int(video["width"]), int(video["height"])
    if rotation in (90, 270):  # ffmpeg는 디코딩 시 자동 회전하므로 표시 크기는 뒤바뀐다
        width, height = height, width

    return {
        "path": str(path.resolve()),
        "name": path.name,
        "duration": float(info["format"]["duration"]),
        "width": width,
        "height": height,
        "fps": round(_fps(video.get("avg_frame_rate") or video["r_frame_rate"]), 3),
        "rotation": rotation,
        "vcodec": video["codec_name"],
        "acodec": audio["codec_name"] if audio else None,
        "has_audio": audio is not None,
    }
