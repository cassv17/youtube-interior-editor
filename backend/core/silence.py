"""무음구간 감지.

ffmpeg로 20ms 단위 음량(RMS dB)을 뽑고, 기준값 아래가 일정 시간 이상 이어지면 무음으로 본다.
기준값은 고정값(-35dB 등)이나 'auto'를 쓴다. auto는 영상마다 배경소음과 말소리 크기를
측정해 그 사이에 기준을 둔다. 차 안처럼 소음이 깔린 영상은 고정 -35dB로는 무음을 못 잡기 때문이다.
"""
import re
from dataclasses import dataclass, asdict

from .media import ffmpeg, run

FRAME_SEC = 0.02
SAMPLE_RATE = 16000
SILENT_DB = -90.0  # 완전 무음(-inf)을 대신하는 값

# auto 기준값: 배경소음(하위 10%)과 말소리(상위 5%) 사이의 35% 지점
NOISE_PERCENTILE = 10
SPEECH_PERCENTILE = 95
AUTO_RATIO = 0.35
# 배경소음과 말소리 차이가 이보다 작으면 판단 신뢰도가 낮다 → "확인 필요"
LOW_CONTRAST_DB = 12.0
# 무음 구간 평균 음량이 기준값과 이만큼 이내면 경계가 애매하다 → "확인 필요"
NEAR_THRESHOLD_DB = 3.0


@dataclass
class SilenceParams:
    threshold: str | float = "auto"  # "auto" 또는 dB 숫자 (예: -35)
    min_silence: float = 0.6         # 이 길이(초) 이상 조용해야 무음으로 본다
    pad: float = 0.15                # 말 앞뒤로 남겨 둘 여유(초). 말끝 잘림 방지
    min_cut: float = 0.2             # 여유를 뺀 뒤 이보다 짧은 컷은 버린다

    def to_dict(self) -> dict:
        return asdict(self)


def measure_levels(path: str) -> list[float]:
    """20ms 프레임별 RMS 음량(dB) 목록. 오디오가 없으면 빈 목록."""
    samples = int(SAMPLE_RATE * FRAME_SEC)
    af = (
        f"aresample={SAMPLE_RATE},aformat=channel_layouts=mono,"
        f"asetnsamples=n={samples}:p=0,"
        "astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,"
        "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-"
    )
    out = run([
        ffmpeg(), "-hide_banner", "-nostats", "-loglevel", "error",
        "-i", path, "-vn", "-af", af, "-f", "null", "-",
    ]).stdout.decode("utf-8", "replace")
    levels = []
    for m in re.finditer(r"RMS_level=(\S+)", out):
        v = m.group(1)
        levels.append(SILENT_DB if v in ("-inf", "inf", "nan") else max(float(v), SILENT_DB))
    return levels


def _percentile(values: list[float], p: float) -> float:
    s = sorted(values)
    k = (len(s) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def analyze_levels(levels: list[float], threshold: str | float) -> dict:
    """배경소음·말소리 크기와 사용할 기준값. auto일 때 신뢰도도 판단한다."""
    if not levels:
        return {"noise_db": None, "speech_db": None, "threshold_db": None,
                "low_confidence": True, "note": "오디오 없음"}
    noise = _percentile(levels, NOISE_PERCENTILE)
    speech = _percentile(levels, SPEECH_PERCENTILE)
    contrast = speech - noise
    if threshold == "auto":
        th = noise + contrast * AUTO_RATIO
        low = contrast < LOW_CONTRAST_DB
        note = (f"배경소음과 말소리 차이가 {contrast:.1f}dB로 작음. 컷 정확도 확인 필요"
                if low else "")
    else:
        th = float(threshold)
        low = False
        note = ""
    return {"noise_db": round(noise, 1), "speech_db": round(speech, 1),
            "threshold_db": round(th, 1), "low_confidence": low, "note": note}


def find_silences(levels: list[float], threshold_db: float, min_silence: float) -> list[dict]:
    """기준값 아래가 min_silence 이상 이어지는 구간. 시간은 클립 기준(초)."""
    result = []
    start = None
    for i, db in enumerate(levels + [0.0]):  # 끝에 큰 값 하나를 붙여 마지막 구간을 닫는다
        quiet = db < threshold_db and i < len(levels)
        if quiet and start is None:
            start = i
        elif not quiet and start is not None:
            if (i - start) * FRAME_SEC >= min_silence:
                seg = levels[start:i]
                result.append({
                    "start": round(start * FRAME_SEC, 3),
                    "end": round(i * FRAME_SEC, 3),
                    "mean_db": round(sum(seg) / len(seg), 1),
                })
            start = None
    return result


def silences_to_cuts(silences: list[dict], duration: float, params: SilenceParams,
                     threshold_db: float) -> list[dict]:
    """무음 구간에서 말 앞뒤 여유를 빼고 실제로 잘라낼 구간을 만든다.

    영상 맨 앞/맨 끝에 붙은 무음은 말이 없는 쪽이므로 여유를 두지 않는다.
    """
    cuts = []
    for s in silences:
        start = s["start"] if s["start"] <= FRAME_SEC else s["start"] + params.pad
        end = min(s["end"], duration)
        end = end if end >= duration - FRAME_SEC * 2 else end - params.pad
        if end - start < params.min_cut:
            continue
        reasons = []
        if threshold_db - s["mean_db"] < NEAR_THRESHOLD_DB:
            reasons.append("무음 음량이 기준값에 가까움")
        cuts.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "mean_db": s["mean_db"],
            "needs_review": bool(reasons),
            "review_reasons": reasons,
        })
    return cuts


def detect(path: str, duration: float, params: SilenceParams,
           levels: list[float] | None = None) -> dict:
    """클립 하나의 무음 분석 결과: 음량 통계 + 컷 후보(클립 기준 시간)."""
    if levels is None:
        levels = measure_levels(path)
    stats = analyze_levels(levels, params.threshold)
    if stats["threshold_db"] is None:
        return {"stats": stats, "silences": [], "cuts": []}
    silences = find_silences(levels, stats["threshold_db"], params.min_silence)
    cuts = silences_to_cuts(silences, duration, params, stats["threshold_db"])
    if stats["low_confidence"]:
        for c in cuts:
            c["needs_review"] = True
            c["review_reasons"].append("클립 전체의 소음 대비가 낮음")
    return {"stats": stats, "silences": silences, "cuts": cuts}
