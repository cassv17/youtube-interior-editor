"""추가 자료(다른 레이어에 올릴 영상·이미지·음악) 처리. 원본 파일은 프로젝트 폴더에 사본으로만 둔다.

브라우저가 바로 재생하지 못하는 형식(mov·hevc·flac 등)이 있어 미리보기용 사본을 따로 만든다.
내보내기에는 사본이 아니라 올린 파일 자체를 쓴다.
"""
import json
import re
from pathlib import Path

from .media import MediaError, ffmpeg, ffprobe, run

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma"}
DEFAULT_IMAGE_SECONDS = 5.0


def kind_of(name: str) -> str | None:
    ext = Path(name).suffix.lower()
    if ext in VIDEO_EXT:
        return "video"
    if ext in IMAGE_EXT:
        return "image"
    if ext in AUDIO_EXT:
        return "audio"
    return None


def probe_asset(path: Path, kind: str) -> dict:
    out = run([ffprobe(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]).stdout
    info = json.loads(out.decode("utf-8", "replace"))
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    audio = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    if kind in ("video", "image") and video is None:
        raise MediaError(f"영상 정보를 읽을 수 없습니다: {path.name}")
    if kind == "audio" and audio is None:
        raise MediaError(f"소리 정보를 읽을 수 없습니다: {path.name}")
    width = height = 0
    if video:
        width, height = int(video["width"]), int(video["height"])
        for sd in video.get("side_data_list", []):
            if "rotation" in sd and int(round(float(sd["rotation"]))) % 360 in (90, 270):
                width, height = height, width
    try:
        duration = float(info["format"]["duration"])
    except (KeyError, TypeError, ValueError):
        duration = 0.0
    if kind == "image":
        duration = DEFAULT_IMAGE_SECONDS
    elif duration <= 0.1:
        raise MediaError(f"길이를 알 수 없는 파일입니다: {path.name}")
    return {"duration": round(duration, 3), "width": width, "height": height,
            "has_audio": audio is not None if kind != "image" else False}


def make_preview(src: Path, kind: str, out_dir: Path, aid: str) -> str:
    """미리보기용 사본을 만들고 파일 이름을 돌려준다."""
    out_dir.mkdir(parents=True, exist_ok=True)
    if kind == "video":
        name = f"{aid}.mp4"
        run([ffmpeg(), "-y", "-v", "error", "-i", str(src), "-vf", "scale=-2:480,format=yuv420p",
             "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-g", "15",
             "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(out_dir / name)])
    elif kind == "audio":
        name = f"{aid}.m4a"
        run([ffmpeg(), "-y", "-v", "error", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "128k", str(out_dir / name)])
    else:
        keep_alpha = src.suffix.lower() in (".png", ".webp", ".gif")
        name = f"{aid}.png" if keep_alpha else f"{aid}.jpg"
        run([ffmpeg(), "-y", "-v", "error", "-i", str(src), "-frames:v", "1",
             "-vf", "scale='min(1920,iw)':-2", *([] if keep_alpha else ["-q:v", "3"]), str(out_dir / name)])
    return name


def safe_name(name: str) -> str:
    base = re.sub(r'[\\/:*?"<>|]', "_", Path(name).name) or "file"
    return base[:80]
