"""레퍼런스 영상 분석: 편집 리듬(말 사이 간격)과 자막 스타일(위치·크기·색)을 추정한다.

레퍼런스는 분석만 하고 저장하지 않는다(영상은 임시 파일로만 쓰고 지움). 결과는 모두 추정값이라
화면에서 사용자가 확인한 뒤 적용하고, 적용 뒤에도 편집 화면에서 고칠 수 있다.
"""
import numpy as np

from . import silence
from .media import MediaError, ffmpeg, probe, run

SAMPLES = 24            # 자막 찾기용으로 뽑는 프레임 수
COLOR_SAMPLES = 10      # 글자색 읽기용으로 원본 해상도로 잘라 보는 프레임 수
FRAME_W = 640           # 분석용 프레임 가로 크기(px)
EDGE_DIFF = 50          # 좌우 밝기 차이가 이 이상이면 글자 가장자리로 본다
TEXT_ROW_DENSITY = 0.04  # 한 줄에서 가장자리 비율이 이 이상이면 글자가 있는 줄
MIN_PERSISTENCE = 0.35  # 샘플 프레임 중 이 비율 이상에서 같은 줄에 글자가 있어야 자막으로 인정
SIZE_PER_BAND = 0.95    # 자막 띠 높이(영상 대비 %)를 Style.size로 바꾸는 비율 (실제 렌더링으로 보정)
MIN_PAUSES = 5          # 간격 표본이 이보다 적으면 리듬을 믿을 수 없다


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


# ---------- 편집 리듬 ----------

def analyze_rhythm(path: str) -> dict:
    """레퍼런스에 남아 있는 말 사이 간격으로 내 영상의 무음 컷 설정을 정한다.

    레퍼런스는 이미 편집된 영상이므로 남은 간격이 '사람이 허용한 여유'다.
    간격 중앙값의 절반을 말 앞뒤 여유(pad)로, 상위 10% 간격을 컷 기준 길이로 삼는다.
    """
    levels = silence.measure_levels(path)
    stats = silence.analyze_levels(levels, "auto")
    if stats["threshold_db"] is None:
        return {"ok": False, "note": "레퍼런스에 소리가 없어 리듬을 읽지 못했습니다."}
    pauses = silence.find_silences(levels, stats["threshold_db"], 0.1)
    # 영상 맨 앞뒤의 무음은 편집 리듬이 아니므로 뺀다
    total = len(levels) * silence.FRAME_SEC
    pauses = [p for p in pauses if p["start"] > 0.05 and p["end"] < total - 0.05]
    lengths = sorted(p["end"] - p["start"] for p in pauses)
    if len(lengths) < MIN_PAUSES:
        return {"ok": False, "note": f"말 사이 간격이 {len(lengths)}개뿐이라 리듬을 읽지 못했습니다."}

    median = float(np.percentile(lengths, 50))
    p90 = float(np.percentile(lengths, 90))
    pad = round(_clamp(median / 2, 0.05, 0.30), 2)
    min_silence = round(max(_clamp(p90, 0.3, 1.2), 2 * pad + 0.2), 2)
    speech = sum(1 for db in levels if db >= stats["threshold_db"]) / len(levels)
    label = "빠름" if median < 0.25 else "보통" if median < 0.5 else "느림"
    return {
        "ok": True,
        "label": label,
        "median_pause": round(median, 2),
        "p90_pause": round(p90, 2),
        "pauses_per_min": round(len(lengths) / (total / 60), 1),
        "speech_ratio": round(speech, 2),
        "silence": {"min_silence": min_silence, "pad": pad},
        "note": "",
    }


# ---------- 자막 스타일 ----------

def _frames(path: str, info: dict) -> tuple[list[np.ndarray], int, int]:
    w = FRAME_W
    h = max(2, int(round(w * info["height"] / info["width"] / 2)) * 2)
    dur = info["duration"]
    frames = []
    for i in range(SAMPLES):
        t = dur * (0.05 + 0.9 * i / (SAMPLES - 1))
        try:
            raw = run([ffmpeg(), "-v", "error", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1",
                       "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout
        except MediaError:
            continue
        if len(raw) == w * h * 3:
            frames.append(np.frombuffer(raw, np.uint8).reshape(h, w, 3))
    return frames, w, h


def _luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def _text_rows(frames: list[np.ndarray], h: int, w: int) -> np.ndarray:
    """줄마다 '글자가 있는 프레임의 비율'(0~1)."""
    c0, c1 = int(w * 0.2), int(w * 0.8)  # 가운데 60%만 본다(구석의 로고·워터마크 제외)
    hits = np.zeros(h)
    for f in frames:
        g = _luma(f[:, c0:c1].astype(np.float32))
        density = (np.abs(np.diff(g, axis=1)) > EDGE_DIFF).mean(axis=1)
        hits += density > TEXT_ROW_DENSITY
    p = hits / max(len(frames), 1)
    return np.convolve(p, np.ones(3) / 3, mode="same")


def _band(p: np.ndarray, h: int) -> tuple[int, int, float] | None:
    """위쪽 30% / 아래쪽 45% 안에서 가장 뚜렷한 자막 띠(시작줄, 끝줄, 뚜렷함)."""
    best = None
    for lo, hi in ((0, int(h * 0.30)), (int(h * 0.55), h)):
        seg = p[lo:hi]
        if seg.size == 0:
            continue
        peak = int(seg.argmax())
        if best is None or seg[peak] > best[2]:
            best = (lo + peak, seg[peak], lo, hi)
    if best is None or best[1] < MIN_PERSISTENCE:
        return None
    r, peak, lo, hi = best
    keep = peak * 0.5
    a = b = r
    while a - 1 >= lo and p[a - 1] >= keep:
        a -= 1
    while b + 1 < hi and p[b + 1] >= keep:
        b += 1
    return a, b, float(peak)


def _dilate(mask: np.ndarray, r: int = 2) -> np.ndarray:
    wide = np.zeros_like(mask)
    for d in range(-r, r + 1):
        wide |= np.roll(mask, d, axis=1)
    out = np.zeros_like(mask)
    for d in range(-r, r + 1):
        out |= np.roll(wide, d, axis=0)
    return out


def _enclosed(dark: np.ndarray, reach: int = 6) -> np.ndarray:
    """왼쪽과 오른쪽 모두 가까이에 어두운 픽셀이 있는 곳. 외곽선 사이에 낀 글자 속 픽셀이 해당한다.
    (배경은 외곽선과 한쪽에서만 맞닿으므로 걸러진다.)"""
    left = np.zeros_like(dark)
    right = np.zeros_like(dark)
    for d in range(1, reach + 1):
        left |= np.roll(dark, d, axis=1)
        right |= np.roll(dark, -d, axis=1)
    return left & right & ~dark


def _band_crops(path: str, info: dict, r0: int, r1: int, h: int) -> list[tuple[np.ndarray, int, int]]:
    """자막 띠 주변을 원본 해상도로 잘라 온다(축소하면 얇은 글자 색이 번진다).
    각 항목: (잘린 이미지, 띠 시작 줄, 띠 끝 줄) — 줄 번호는 잘린 이미지 기준."""
    H, W = info["height"], info["width"]
    y0, y1 = int(r0 / h * H), int((r1 + 1) / h * H)
    margin = max(2, (y1 - y0) // 6)
    thick = max(4, (y1 - y0) // 2)
    ya, yb = max(0, y0 - margin - thick), min(H, y1 + margin + thick)
    x0, cw = int(W * 0.2), int(W * 0.6) // 2 * 2
    out = []
    for i in range(COLOR_SAMPLES):
        t = info["duration"] * (0.05 + 0.9 * i / (COLOR_SAMPLES - 1))
        try:
            raw = run([ffmpeg(), "-v", "error", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1",
                       "-vf", f"crop={cw}:{yb - ya}:{x0}:{ya}", "-f", "rawvideo", "-pix_fmt", "rgb24",
                       "pipe:1"]).stdout
        except MediaError:
            continue
        if len(raw) == cw * (yb - ya) * 3:
            out.append((np.frombuffer(raw, np.uint8).reshape(yb - ya, cw, 3),
                        y0 - margin - ya, y1 + margin - ya))
    return out


def _colors(crops: list[tuple[np.ndarray, int, int]]) -> tuple[str, str] | None:
    """자막 띠 안에서 '어두운 테두리에 둘러싸인 밝은 픽셀'을 글자색으로, 그 테두리 색을 외곽선 색으로 본다."""
    fills, outlines = [], []
    for img, b0, b1 in crops:
        band = img[b0:b1].astype(np.float32)
        # 띠 바로 위·아래 줄의 열별 중앙값 = 그 자리의 배경색. 글자 사이로 비치는 배경을 걸러내는 데 쓴다
        around = np.concatenate([img[:b0], img[b1:]]).astype(np.float32)
        if around.shape[0] == 0 or band.shape[0] == 0:
            continue
        bg = np.median(around, axis=0)[None]
        differs = np.linalg.norm(band - bg, axis=2) > 70
        g = _luma(band)
        dark = g < 70
        sat = band.max(axis=2) - band.min(axis=2)
        reach = max(3, round(band.shape[0] * 0.10))
        fill = _enclosed(dark, reach) & differs & ((g > 150) | ((g > 110) & (sat > 90)))
        if fill.sum() >= 20:
            fills.append(band[fill])
            outlines.append(band[dark & _dilate(fill, max(2, reach // 2))])
    if not fills:
        return None
    px = np.concatenate(fills)
    # 가는 글자는 가장자리가 외곽선과 섞여 색이 흐려지므로, 밝은 쪽 25%가 원래 글자색에 가장 가깝다
    luma = _luma(px)
    px = px[luma >= np.percentile(luma, 75)]
    bins = (px // 16).astype(np.int32)
    keys = bins[:, 0] * 256 + bins[:, 1] * 16 + bins[:, 2]
    top = np.bincount(keys).argmax()
    fill_rgb = px[keys == top].mean(axis=0)
    out_px = np.concatenate(outlines) if outlines else np.zeros((0, 3))
    out_rgb = out_px.mean(axis=0) if len(out_px) >= 10 else np.zeros(3)
    to_hex = lambda c: "#{:02X}{:02X}{:02X}".format(*[int(round(float(v))) for v in c])
    return to_hex(fill_rgb), to_hex(out_rgb)


def analyze_subtitle_style(path: str, info: dict) -> dict:
    frames, w, h = _frames(path, info)
    if len(frames) < SAMPLES // 2:
        return {"ok": False, "note": "영상에서 프레임을 충분히 읽지 못했습니다."}
    band = _band(_text_rows(frames, h, w), h)
    if band is None:
        return {"ok": False, "note": "자막이 입혀진 영상이 아니거나 위치를 찾지 못했습니다."}
    r0, r1, conf = band
    position = "top" if (r0 + r1) / 2 < h / 2 else "bottom"
    margin = (r0 if position == "top" else h - 1 - r1) / h * 100
    size = (r1 - r0 + 1) / h * 100 * SIZE_PER_BAND
    colors = _colors(_band_crops(path, info, r0, r1, h))
    style = {
        "position": position,
        "margin": round(_clamp(margin, 1.0, 20.0), 1),
        "size": round(_clamp(size, 2.5, 9.0), 1),
    }
    note = ""
    if colors:
        style["color"], style["outline_color"] = colors
    else:
        note = "글자 색은 읽지 못해 기존 색을 유지합니다."
    if (r1 - r0 + 1) / h > 0.12:
        note = (note + " 자막이 두 줄 이상일 수 있어 크기를 확인해 주세요.").strip()
    return {"ok": True, "confidence": round(min(conf, 1.0), 2), "style": style, "note": note}


# ---------- 전체 ----------

def analyze(path: str) -> dict:
    info = probe(path)
    return {
        "name": info["name"],
        "duration": round(info["duration"], 1),
        "rhythm": analyze_rhythm(path) if info["has_audio"] else
                  {"ok": False, "note": "레퍼런스에 소리가 없어 리듬을 읽지 못했습니다."},
        "subtitle": analyze_subtitle_style(path, info),
    }
