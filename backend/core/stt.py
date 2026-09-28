"""로컬 음성인식(faster-whisper)으로 타임스탬프 자막을 만든다. 영상/음성은 외부로 전송하지 않는다.

흐름: 클립별 인식(단어 단위 시간 포함) → 한 줄 길이 기준으로 자막 블록 분할
     → 신뢰도 낮은 부분에 "확인 필요" 표시 → 타임라인 시간으로 변환.
"""
import os
import re
from dataclasses import dataclass, asdict
from pathlib import Path

from . import cuts

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "models" / "large-v3-turbo"

# 조용하거나 잡음뿐인 구간에서 Whisper가 지어내는 것으로 잘 알려진 문구
HALLUCINATION_PATTERNS = [
    r"시청(해\s*주셔서|해주셔서)\s*감사", r"구독(과|,)?\s*좋아요", r"다음\s*영상에서\s*만나",
    r"MBC\s*뉴스", r"KBS\s*뉴스", r"자막\s*(제공|by)", r"감사합니다\.?\s*$",
]
LOW_WORD_PROB = 0.45       # 이 확률 미만 단어 → 확인 필요
LOW_SEGMENT_LOGPROB = -1.0  # 문장 평균 로그확률이 이보다 낮으면 → 확인 필요
HIGH_NO_SPEECH = 0.6        # '말이 아닐' 확률이 이보다 높으면 → 확인 필요


@dataclass
class SubtitleParams:
    max_chars: int = 25      # 한 줄 최대 글자 수(공백 포함). 참고 영상은 하단 한 줄 자막
    max_gap: float = 0.6     # 단어 사이가 이만큼 벌어지면 자막을 끊는다
    min_duration: float = 0.7  # 자막 최소 표시 시간(다음 자막과 겹치지 않는 범위에서 늘림)

    def to_dict(self) -> dict:
        return asdict(self)


_model = None


def load_model():
    """모델은 한 번만 올려 재사용한다 (로딩에 수 초 걸림)."""
    global _model
    if _model is None:
        if not (MODEL_DIR / "model.bin").is_file():
            raise RuntimeError(f"음성인식 모델이 없습니다: {MODEL_DIR}  (README의 설치 단계를 확인하세요)")
        from faster_whisper import WhisperModel
        threads = max(1, min(8, (os.cpu_count() or 4) - 2))
        _model = WhisperModel(str(MODEL_DIR), device="cpu", compute_type="int8", cpu_threads=threads)
    return _model


def transcribe_clip(path: str, duration: float, progress=None) -> list[dict]:
    """클립 하나를 인식해 문장(segment) 목록을 돌려준다. 시간은 클립 기준."""
    model = load_model()
    segments, _info = model.transcribe(
        path, language="ko", word_timestamps=True, beam_size=5,
        vad_filter=True, vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,  # 앞 문장을 따라 같은 말을 반복하는 오류 방지
    )
    result = []
    for seg in segments:  # 제너레이터: 도는 동안 실제 인식이 진행된다
        words = [{"w": w.word, "s": round(w.start, 3), "e": round(w.end, 3),
                  "p": round(w.probability, 3)} for w in (seg.words or [])]
        result.append({"start": seg.start, "end": seg.end, "text": seg.text.strip(),
                       "avg_logprob": seg.avg_logprob, "no_speech_prob": seg.no_speech_prob,
                       "words": words})
        if progress:
            progress(min(seg.end / duration, 1.0) if duration else 1.0)
    return result


def _segment_reasons(seg: dict) -> list[str]:
    reasons = []
    if seg["avg_logprob"] < LOW_SEGMENT_LOGPROB:
        reasons.append("문장 인식 신뢰도 낮음")
    if seg["no_speech_prob"] > HIGH_NO_SPEECH:
        reasons.append("말소리가 아닐 가능성 높음")
    if any(re.search(p, seg["text"]) for p in HALLUCINATION_PATTERNS):
        reasons.append("Whisper가 자주 지어내는 문구")
    return reasons


def split_blocks(segments: list[dict], params: SubtitleParams) -> list[dict]:
    """단어 단위 시간으로 자막 블록을 나눈다. 문장이 바뀌거나, 글자 수를 넘거나, 쉼이 길면 끊는다."""
    blocks = []
    for seg in segments:
        seg_reasons = _segment_reasons(seg)
        words = seg["words"] or [{"w": " " + seg["text"], "s": seg["start"], "e": seg["end"], "p": 1.0}]
        cur: list[dict] = []

        def flush():
            if not cur:
                return
            text = "".join(w["w"] for w in cur).strip()
            if text:
                low = [w["w"].strip() for w in cur if w["p"] < LOW_WORD_PROB]
                reasons = list(seg_reasons)
                if low:
                    reasons.append("불확실한 단어: " + ", ".join(low))
                blocks.append({"start": cur[0]["s"], "end": cur[-1]["e"], "text": text,
                               "needs_review": bool(reasons), "review_reasons": reasons,
                               "words": list(cur)})
            cur.clear()

        for w in words:
            if cur:
                too_long = len(("".join(x["w"] for x in cur) + w["w"]).strip()) > params.max_chars
                gap = w["s"] - cur[-1]["e"] > params.max_gap
                sentence_end = cur[-1]["w"].rstrip().endswith((".", "?", "!"))
                if too_long or gap or sentence_end:
                    flush()
            cur.append(w)
        flush()

    # 너무 짧게 스쳐 가는 자막은 다음 자막과 겹치지 않는 선에서 늘린다
    for i, b in enumerate(blocks):
        limit = blocks[i + 1]["start"] if i + 1 < len(blocks) else b["end"] + params.min_duration
        if b["end"] - b["start"] < params.min_duration:
            b["end"] = min(b["start"] + params.min_duration, max(limit, b["end"]))
        b["start"], b["end"] = round(b["start"], 3), round(b["end"], 3)
    return blocks


def transcribe_project(project: dict, params: SubtitleParams, progress=None) -> dict:
    """프로젝트의 모든 클립을 인식해 subtitles를 채우고, 단어 기준으로 컷을 보정한다.

    돌려주는 값은 컷 보정 통계(cuts.refine_with_words 참고).
    """
    subs = []
    total = project["duration"] or 1.0
    for clip in project["clips"]:
        if not clip["has_audio"]:
            continue
        cb = (lambda f, c=clip: progress((c["offset"] + f * c["duration"]) / total, c["name"])) \
            if progress else None
        segments = transcribe_clip(clip["path"], clip["duration"], cb)
        for b in split_blocks(segments, params):
            off = clip["offset"]
            subs.append({
                "id": f"s{len(subs) + 1}",
                "clip_id": clip["id"],
                "start": round(b["start"] + off, 3),
                "end": round(min(b["end"], clip["duration"]) + off, 3),
                "text": b["text"],
                "needs_review": b["needs_review"],
                "review_reasons": b["review_reasons"],
                "words": [{**w, "s": round(w["s"] + off, 3), "e": round(w["e"] + off, 3)}
                          for w in b["words"]],
            })
    project["subtitles"] = subs
    project["subtitle_params"] = params.to_dict()
    return cuts.refine_with_words(project)
