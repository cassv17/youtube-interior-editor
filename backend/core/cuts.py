"""음성인식 결과로 무음 컷을 보정한다.

소리 크기만 보는 무음 감지는 소음 속 작은 말소리를 무음으로 착각할 수 있다(차 안 테스트 영상에서 확인).
그래서 인식된 단어 앞뒤 pad 초는 자르지 않도록 컷을 줄이거나 나눈다. 단어 시간도 오차가 있으므로
틀리더라도 '덜 자르는' 쪽으로 틀리게 한다.

반대로 소음 때문에 무음으로 안 잡혔지만 인식된 말이 없는 긴 구간은 '제안 컷'(enabled=False)으로만
추가한다. 사용자가 켜야 적용된다.
"""

GAP_PROPOSAL_MIN = 1.0  # 말이 없는 구간이 이 길이(초) 이상이면 제안 컷으로 추가
REFINED = "음성인식 단어를 피해 컷 조정"
PROPOSED = "말소리 없음(음성인식 기준). 소리 크기로는 무음이 아니라 직접 확인 필요"


def _subtract(start: float, end: float, blocks: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """[start, end]에서 blocks 구간들을 뺀 나머지 조각들."""
    pieces = [(start, end)]
    for bs, be in blocks:
        nxt = []
        for ps, pe in pieces:
            if be <= ps or bs >= pe:
                nxt.append((ps, pe))
                continue
            if bs > ps:
                nxt.append((ps, bs))
            if be < pe:
                nxt.append((be, pe))
        pieces = nxt
    return pieces


def refine_with_words(project: dict) -> dict:
    """project['cuts']를 단어 기준으로 보정한다. 보정 전후 통계를 돌려준다."""
    params = project["silence_params"]
    pad, min_cut = params["pad"], params["min_cut"]
    clips = {c["id"]: c for c in project["clips"]}
    words_by_clip: dict[str, list[tuple[float, float]]] = {}
    for s in project["subtitles"]:
        words_by_clip.setdefault(s["clip_id"], []).extend((w["s"], w["e"]) for w in s["words"])

    before = sum(c["end"] - c["start"] for c in project["cuts"] if c.get("enabled", True))
    new_cuts = []
    # 1) 기존 컷(사용자가 직접 만든 것은 제외)에서 단어 구간을 뺀다
    for cut in project["cuts"]:
        if cut.get("origin") == "no-speech" and not cut.get("enabled"):
            continue  # 아직 안 켠 제안 컷은 아래에서 새 자막 기준으로 다시 만든다
        if cut.get("origin") != "silence":
            new_cuts.append(cut)
            continue
        clip = clips[cut["clip_id"]]
        c_start, c_end = clip["offset"], clip["offset"] + clip["duration"]
        protect = [(max(c_start, s - pad), min(c_end, e + pad)) for s, e in words_by_clip.get(cut["clip_id"], [])]
        pieces = [p for p in _subtract(cut["start"], cut["end"], protect) if p[1] - p[0] >= min_cut]
        changed = pieces != [(cut["start"], cut["end"])]
        for ps, pe in pieces:
            reasons = list(cut["review_reasons"])
            if changed:
                reasons = [r for r in reasons if not r.startswith(REFINED)]
                reasons.append(f"{REFINED} (원래 {cut['start']:.2f}~{cut['end']:.2f}초)")
            new_cuts.append({**cut, "start": round(ps, 3), "end": round(pe, 3),
                             "enabled": cut.get("enabled", True),
                             "needs_review": bool(reasons), "review_reasons": reasons})

    # 2) 말이 없는데 컷도 없는 긴 구간 → 꺼진 상태의 제안 컷
    for clip in project["clips"]:
        if not clip["has_audio"]:
            continue
        c_start, c_end = clip["offset"], clip["offset"] + clip["duration"]
        protect = [(max(c_start, s - pad), min(c_end, e + pad)) for s, e in words_by_clip.get(clip["id"], [])]
        taken = protect + [(c["start"], c["end"]) for c in new_cuts if c["clip_id"] == clip["id"]]
        for gs, ge in _subtract(c_start, c_end, sorted(taken)):
            if ge - gs >= GAP_PROPOSAL_MIN:
                new_cuts.append({"clip_id": clip["id"], "start": round(gs, 3), "end": round(ge, 3),
                                 "origin": "no-speech", "mean_db": None, "enabled": False,
                                 "needs_review": True, "review_reasons": [PROPOSED]})

    new_cuts.sort(key=lambda c: c["start"])
    for i, c in enumerate(new_cuts):
        c["id"] = f"cut-{i + 1}"
    project["cuts"] = new_cuts
    after = sum(c["end"] - c["start"] for c in new_cuts if c.get("enabled", True))
    return {
        "before_seconds": round(before, 2),
        "after_seconds": round(after, 2),
        "adjusted": sum(1 for c in new_cuts if any(r.startswith(REFINED) for r in c["review_reasons"])),
        "proposed": sum(1 for c in new_cuts if c["origin"] == "no-speech"),
        "proposed_seconds": round(sum(c["end"] - c["start"] for c in new_cuts if c["origin"] == "no-speech"), 2),
    }
