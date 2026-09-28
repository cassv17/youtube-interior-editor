"""프로젝트 = 순서가 정해진 클립 목록 + 이어붙인 타임라인 위의 컷·자막.

모든 컷/자막 시간은 '타임라인 시간'(클립을 순서대로 이어붙였을 때의 초)으로 저장한다.
자동 컷은 한 클립 안에만 존재한다(클립 경계를 넘지 않음).
클립 길이는 30fps 프레임 단위로 내림해 쓴다. 미리보기·내보내기에서 클립을 이어붙일 때
영상/음성 길이 차이로 싱크가 밀리지 않게 하기 위해서다(클립당 최대 1프레임 손실).
"""
import json
import math
from datetime import datetime
from pathlib import Path

from . import media, silence

PROJECT_VERSION = 1
TIMELINE_FPS = 30

DEFAULT_STYLE = {
    "font": "Malgun Gothic",  # Windows 기본 한글 폰트(맑은 고딕)
    "size": 5.0,              # 영상 높이 대비 글자 크기(%)
    "color": "#FFFFFF",
    "outline_color": "#000000",
    "outline": 0.06,          # 외곽선 두께(글자 크기 대비 비율). 참고 영상처럼 얇게
    "shadow": True,
    "position": "bottom",     # bottom | top
    "margin": 6.0,            # 화면 가장자리와의 거리(영상 높이 대비 %)
}


def snap_duration(seconds: float) -> float:
    return math.floor(seconds * TIMELINE_FPS + 1e-6) / TIMELINE_FPS


def clip_levels(clip: dict, levels_cache: dict | None) -> list[float]:
    if levels_cache is not None and clip["path"] in levels_cache:
        return levels_cache[clip["path"]]
    lv = silence.measure_levels(clip["path"]) if clip["has_audio"] else []
    if levels_cache is not None:
        levels_cache[clip["path"]] = lv
    return lv


def _silence_cuts(clip: dict, levels: list[float], params: silence.SilenceParams) -> tuple[dict, list[dict]]:
    if not clip["has_audio"]:
        return silence.analyze_levels([], params.threshold), []
    result = silence.detect(clip["path"], clip["duration"], params, levels=levels)
    cuts = [{
        "clip_id": clip["id"],
        "start": round(clip["offset"] + c["start"], 3),
        "end": round(clip["offset"] + min(c["end"], clip["duration"]), 3),
        "origin": "silence",
        "enabled": True,
        "mean_db": c["mean_db"],
        "needs_review": c["needs_review"],
        "review_reasons": c["review_reasons"],
    } for c in result["cuts"] if c["start"] < clip["duration"]]
    return result["stats"], cuts


def _renumber(cuts: list[dict]) -> list[dict]:
    cuts.sort(key=lambda c: c["start"])
    for i, c in enumerate(cuts):
        c["id"] = f"cut-{i + 1}"
    return cuts


def build_project(paths: list[str | Path], params: silence.SilenceParams,
                  progress=None, levels_cache: dict | None = None) -> dict:
    """클립들을 분석해 새 프로젝트 dict를 만든다. progress(i, n, name)로 진행 상황을 알린다.

    levels_cache({path: 음량 목록})를 넘기면 측정값을 채워 두어 재감지·파형 표시에 재사용한다.
    """
    clips, analysis, cuts = [], {}, []
    offset = 0.0
    for i, p in enumerate(paths):
        info = media.probe(p)
        if progress:
            progress(i, len(paths), info["name"])
        clip = {"id": f"c{i + 1}", **info, "source_duration": info["duration"],
                "duration": snap_duration(info["duration"]), "offset": round(offset, 6)}
        clips.append(clip)
        stats, clip_cuts = _silence_cuts(clip, clip_levels(clip, levels_cache), params)
        analysis[clip["id"]] = stats
        cuts += clip_cuts
        offset += clip["duration"]

    first = clips[0]
    return {
        "version": PROJECT_VERSION,
        "created": datetime.now().isoformat(timespec="seconds"),
        "duration": round(offset, 6),
        "clips": clips,
        "output": {"width": first["width"], "height": first["height"], "fps": TIMELINE_FPS},
        "silence_params": params.to_dict(),
        "clip_analysis": analysis,
        "cuts": _renumber(cuts),
        "subtitles": [],
        "style": dict(DEFAULT_STYLE),
    }


def redetect(project: dict, params: silence.SilenceParams, levels_cache: dict | None = None) -> dict:
    """무음 설정값을 바꿔 자동 컷만 다시 만든다. 직접 만들거나 수정한 컷(origin=user)과 자막은 유지한다."""
    from . import cuts as cuts_mod

    kept = [c for c in project["cuts"] if c["origin"] == "user"]
    new = []
    for clip in project["clips"]:
        stats, clip_cuts = _silence_cuts(clip, clip_levels(clip, levels_cache), params)
        project["clip_analysis"][clip["id"]] = stats
        new += clip_cuts
    project["silence_params"] = params.to_dict()
    project["cuts"] = _renumber(kept + new)
    if project["subtitles"]:
        cuts_mod.refine_with_words(project)
    return project


def _check_groups(order: list[str], groups: list[dict]) -> list[dict]:
    """그룹 = 순서상 붙어 있는 클립 묶음. 한 클립은 한 그룹에만 속한다."""
    pos = {cid: i for i, cid in enumerate(order)}
    seen: set[str] = set()
    clean = []
    for i, g in enumerate(groups):
        members = [c for c in g.get("clips", []) if c in pos]
        if len(members) < 2:
            continue
        if seen & set(members):
            raise ValueError("한 클립이 여러 그룹에 들어 있습니다.")
        idx = sorted(pos[c] for c in members)
        if idx != list(range(idx[0], idx[0] + len(idx))):
            raise ValueError("그룹의 클립은 서로 붙어 있어야 합니다.")
        seen |= set(members)
        clean.append({"id": g.get("id") or f"g{i + 1}", "name": str(g.get("name") or f"그룹 {i + 1}"),
                      "clips": sorted(members, key=pos.get)})
    return clean


def reorder(project: dict, order: list[str], groups: list[dict]) -> dict:
    """클립 순서를 바꾼다. 각 클립의 컷·자막은 클립과 함께 움직인다(세트 이동).

    클립 경계를 넘는 직접 만든 컷은 클립별로 나누고, 경계를 넘는 자막은 시작한 클립 끝에서 자른다.
    """
    clips = {c["id"]: c for c in project["clips"]}
    if sorted(order) != sorted(clips):
        raise ValueError("클립 순서 정보가 올바르지 않습니다.")
    groups = _check_groups(order, groups)

    def local_spans(start: float, end: float):
        for c in project["clips"]:
            s, e = max(start, c["offset"]), min(end, c["offset"] + c["duration"])
            if e - s > 1e-6:
                yield c["id"], s - c["offset"], e - c["offset"]

    local_cuts = []
    for cut in project["cuts"]:
        pieces = list(local_spans(cut["start"], cut["end"]))
        for k, (cid, s, e) in enumerate(pieces):
            local_cuts.append((cid, s, e, {**cut, "id": cut["id"] if k == 0 else f"{cut['id']}-{k + 1}"}))
    local_subs = []
    for sub in project["subtitles"]:
        # 자막이 기록해 둔 소속 클립을 우선 쓴다(경계에 딱 붙은 자막이 옆 클립으로 판정되는 것 방지)
        c = clips.get(sub.get("clip_id")) or clip_at(project, sub["start"])
        s = max(0.0, sub["start"] - c["offset"])
        e = min(sub["end"] - c["offset"], c["duration"])
        if e - s > 0.05:
            local_subs.append((c["id"], s, e, sub))

    offset = 0.0
    new_clips = []
    for cid in order:
        new_clips.append({**clips[cid], "offset": round(offset, 6)})
        offset += clips[cid]["duration"]
    off = {c["id"]: c["offset"] for c in new_clips}

    def shift_words(words, delta):
        return [{**w, "s": round(w["s"] + delta, 3), "e": round(w["e"] + delta, 3)} for w in words]

    project["clips"] = new_clips
    project["cuts"] = sorted(({**cut, "clip_id": cid, "start": round(off[cid] + s, 3), "end": round(off[cid] + e, 3)}
                              for cid, s, e, cut in local_cuts), key=lambda c: c["start"])
    subs = []
    for cid, s, e, sub in local_subs:
        delta = off[cid] + s - sub["start"]
        subs.append({**sub, "clip_id": cid, "start": round(off[cid] + s, 3), "end": round(off[cid] + e, 3),
                     "words": shift_words(sub.get("words", []), delta)})
    project["subtitles"] = sorted(subs, key=lambda x: x["start"])
    project["groups"] = groups
    return project


def clip_at(project: dict, t: float) -> dict:
    """타임라인 시간 t가 속한 클립."""
    for clip in project["clips"]:
        if t < clip["offset"] + clip["duration"] - 1e-4:  # 경계의 부동소수 오차 여유
            return clip
    return project["clips"][-1]


def summarize(project: dict) -> dict:
    active = [c for c in project["cuts"] if c.get("enabled", True)]
    cut_total = sum(c["end"] - c["start"] for c in active)
    return {
        "clips": len(project["clips"]),
        "duration": round(project["duration"], 2),
        "cuts": len(active),
        "cut_seconds": round(cut_total, 2),
        "result_seconds": round(project["duration"] - cut_total, 2),
        "needs_review": sum(1 for c in project["cuts"] if c["needs_review"]),
    }


def save(project: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)  # 저장 도중 꺼져도 기존 파일이 깨지지 않게
    return path


def load(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))
