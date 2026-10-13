"""레이어(트랙): 영상 V1(메인)·V2·V3…, 자막 S1·S2·S3…, 음성 A1(메인)·A2·A3….

- 트랙 목록은 화면에 보이는 순서(위→아래)로 저장한다. 같은 종류 안에서 위쪽 트랙이 우선 표시된다
  (영상: 아래 트랙을 덮음 / 자막: 위 트랙이 앞에 그려짐 / 음성: 모두 섞여 들림).
- 메인 영상 V1은 '결과 배치'의 조각들이다(원본 영상 + 거기에 붙은 소리 = 메인 음성 A1).
- 추가 항목(overlay)은 결과 영상 시간(E)에 놓인다: 영상·이미지·음악 파일, 원본 영상의 조각(clip).
- 길이·위치는 모두 30fps 프레임 기준으로 내보내기에 반영된다.
"""
import re
from dataclasses import dataclass, field

FPS = 30
MAX_ITEMS = 400
VISUAL_TYPES = {"video", "image", "clip"}
ALL_TYPES = VISUAL_TYPES | {"audio"}
KIND_ORDER = {"subtitle": 0, "video": 1, "audio": 2}
HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _num(v, lo: float, hi: float, default: float | None = None) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:
        return default
    return max(lo, min(hi, f))


def clean_style(style: dict | None) -> dict:
    """자막 스타일 중 허용된 항목만 걸러 낸다(잘못된 값은 버린다)."""
    s = style or {}
    out: dict = {}
    if s.get("position") in ("top", "bottom"):
        out["position"] = s["position"]
    for key, lo, hi in (("margin", 0.0, 30.0), ("size", 2.0, 12.0)):
        v = _num(s.get(key), lo, hi)
        if v is not None:
            out[key] = round(v, 1)
    for key in ("color", "outline_color"):
        if isinstance(s.get(key), str) and HEX.match(s[key]):
            out[key] = s[key].upper()
    return out


# ---------------- 트랙 ----------------

def default_tracks() -> list[dict]:
    t: list[dict] = []
    for n in (3, 2, 1):
        t.append({"id": f"S{n}", "kind": "subtitle", "name": f"자막 {n}", "hidden": False, "locked": False, "style": None})
    for n in (3, 2, 1):
        t.append({"id": f"V{n}", "kind": "video", "name": "메인 영상" if n == 1 else f"영상 {n}",
                  "hidden": False, "locked": False, "main": n == 1})
    for n in (1, 2, 3):
        t.append({"id": f"A{n}", "kind": "audio", "name": "메인 음성" if n == 1 else f"음성 {n}",
                  "muted": False, "locked": False, "volume": 1.0, "main": n == 1})
    return t


def clean_tracks(raw) -> list[dict]:
    """트랙 목록 검증. 메인(V1·A1)이 없으면 만들고, 메인 영상은 영상 트랙 중 맨 아래로 둔다."""
    out: list[dict] = []
    seen: set[str] = set()
    for x in raw[:60] if isinstance(raw, list) else []:
        if not isinstance(x, dict):
            continue
        kind = x.get("kind")
        tid = str(x.get("id", ""))[:12]
        if kind not in KIND_ORDER or not re.fullmatch(r"[A-Za-z0-9_-]+", tid) or tid in seen:
            continue
        seen.add(tid)
        main = bool(x.get("main")) and tid in ("V1", "A1")
        t: dict = {"id": tid, "kind": kind, "name": (str(x.get("name") or tid).strip() or tid)[:20],
                   "locked": bool(x.get("locked")), "main": main}
        if kind == "audio":
            t["muted"] = bool(x.get("muted"))
            t["volume"] = round(_num(x.get("volume"), 0.0, 2.0, 1.0), 2)
        else:
            t["hidden"] = bool(x.get("hidden")) if not main else False  # 메인 영상은 숨길 수 없다
        if kind == "subtitle":
            st = clean_style(x.get("style"))
            t["style"] = st or None
        out.append(t)
    defaults = {d["id"]: d for d in default_tracks()}
    for tid in ("V1", "A1"):
        if tid not in seen:
            out.append(dict(defaults[tid]))
    for kind in ("subtitle", "video", "audio"):
        if not any(t["kind"] == kind for t in out):  # 종류마다 최소 1개는 둔다
            out.append(next(dict(d) for d in default_tracks() if d["kind"] == kind and d["id"].endswith("1")))
    # 종류 순서(자막 → 영상 → 음성)로 정렬하되 종류 안의 순서는 유지, 메인 영상은 영상 트랙 맨 아래
    out.sort(key=lambda t: (KIND_ORDER[t["kind"]], 1 if (t["kind"] == "video" and t.get("main")) else 0))
    return out


def tracks_of(project: dict) -> list[dict]:
    raw = project.get("tracks")
    return clean_tracks(raw) if raw else default_tracks()


def track_map(project: dict) -> dict[str, dict]:
    return {t["id"]: t for t in tracks_of(project)}


def default_subtitle_track(project: dict) -> str:
    subs = [t for t in tracks_of(project) if t["kind"] == "subtitle"]
    return subs[-1]["id"]  # 맨 아래(= 가장 낮은) 자막 트랙


def subtitle_track(project: dict, sub: dict) -> str:
    tm = track_map(project)
    tid = sub.get("track")
    return tid if tid in tm and tm[tid]["kind"] == "subtitle" else default_subtitle_track(project)


def subtitle_layer(project: dict, tid: str) -> int:
    """자막 그리는 순서(ASS Layer): 위 트랙일수록 큰 값 = 앞에 그려진다"""
    subs = [t["id"] for t in tracks_of(project) if t["kind"] == "subtitle"]
    return len(subs) - subs.index(tid) if tid in subs else 1


def subtitle_style(project: dict, tid: str, base: dict) -> dict:
    t = track_map(project).get(tid) or {}
    return {**base, **(t.get("style") or {})}


# ---------------- 합성 항목 ----------------

def clean_overlays(raw, project: dict) -> list[dict]:
    """합성 항목 검증: 종류·트랙 종류가 맞고, 자료·클립이 실제로 있으며, 범위가 원본 안인 것만 남긴다."""
    tracks = track_map(project)
    assets = {a["id"]: a for a in project.get("assets", [])}
    clips = {c["id"]: c for c in project.get("clips", [])}
    out: list[dict] = []
    seen: set[str] = set()
    for x in raw[:MAX_ITEMS] if isinstance(raw, list) else []:
        if not isinstance(x, dict):
            continue
        typ, tid = x.get("type"), x.get("track")
        if typ not in ALL_TYPES or tid not in tracks:
            continue
        kind = tracks[tid]["kind"]
        if (typ == "audio") != (kind == "audio") or kind == "subtitle":
            continue
        if kind == "video" and tracks[tid].get("main"):
            continue  # 메인 영상 트랙에는 '결과 배치'의 조각만 놓인다
        iid = str(x.get("id") or f"ov-{len(out) + 1}")[:40]
        if iid in seen:
            continue
        src = str(x.get("src", ""))
        start = _num(x.get("start"), 0.0, 1e5, 0.0)
        item: dict = {"id": iid, "track": tid, "type": typ, "src": src, "start": round(start, 3)}
        if typ == "clip":
            c = clips.get(src)
            if not c:
                continue
            lo = _num(x.get("src_in"), 0.0, c["duration"], 0.0)
            hi = _num(x.get("src_out"), 0.0, c["duration"], c["duration"])
            item["has_audio"] = bool(c.get("has_audio"))
            item["carry_subs"] = bool(x.get("carry_subs"))  # 메인에서 뺀 조각: 그 구간의 자막을 함께 가져간다
        else:
            a = assets.get(src)
            if not a or a["kind"] != ("image" if typ == "image" else typ):
                continue
            if typ == "image":
                lo, hi = 0.0, _num(x.get("dur"), 0.1, 3600.0, 5.0)
            else:
                lo = _num(x.get("src_in"), 0.0, a["duration"], 0.0)
                hi = _num(x.get("src_out"), 0.0, a["duration"], a["duration"])
            item["has_audio"] = bool(a.get("has_audio"))
        if hi - lo < 0.1:
            continue
        dur = hi - lo
        item.update({"src_in": round(lo, 3), "src_out": round(hi, 3), "dur": round(dur, 3),
                     "volume": round(_num(x.get("volume"), 0.0, 2.0, 1.0), 2),
                     "fade_in": round(_num(x.get("fade_in"), 0.0, dur, 0.0), 2),
                     "fade_out": round(_num(x.get("fade_out"), 0.0, dur, 0.0), 2)})
        if typ != "audio":
            item.update({"x": round(_num(x.get("x"), -1.0, 2.0, 0.5), 3), "y": round(_num(x.get("y"), -1.0, 2.0, 0.5), 3),
                         "scale": round(_num(x.get("scale"), 0.05, 4.0, 1.0), 3),
                         "opacity": round(_num(x.get("opacity"), 0.0, 1.0, 1.0), 2)})
        seen.add(iid)
        out.append(item)
    return out


def clean_markers(raw) -> list[dict]:
    out = []
    for x in raw[:300] if isinstance(raw, list) else []:
        if not isinstance(x, dict):
            continue
        t = _num(x.get("t"), 0.0, 1e5)
        if t is None:
            continue
        out.append({"id": str(x.get("id") or f"mk-{len(out) + 1}")[:40], "t": round(t, 3),
                    "name": str(x.get("name", ""))[:40], "color": str(x.get("color", "#ffb020"))[:9]})
    return sorted(out, key=lambda m: m["t"])


# ---------------- 내보내기용 계획 ----------------

def fr(t: float) -> int:
    return round(t * FPS)


@dataclass
class LayerItem:
    id: str
    type: str                 # video | image | clip | audio
    path: str
    src_in: float             # 파일(또는 클립) 안 시작 위치(초)
    frames: int               # 결과에서 차지하는 프레임 수
    start_f: int              # 결과에서 시작 프레임
    has_audio: bool
    volume: float
    fade_in: float
    fade_out: float
    x: float = 0.5
    y: float = 0.5
    scale: float = 1.0
    opacity: float = 1.0
    track: str = ""
    src: str = ""             # 자료 id 또는 클립 id (XML에서 복사된 미디어 파일을 찾는 데 쓴다)
    name: str = ""
    src_w: int = 0
    src_h: int = 0
    src_fps: float = 30.0
    src_dur: float = 0.0


@dataclass
class Plan:
    visuals: list[LayerItem] = field(default_factory=list)   # 아래 → 위 순서(위 트랙이 나중에 그려져 앞에 보인다)
    audios: list[LayerItem] = field(default_factory=list)    # 영상 항목의 소리도 포함
    main_volume: float = 1.0
    end_f: int = 0                                           # 모든 항목이 끝나는 프레임

    @property
    def empty(self) -> bool:
        return not self.visuals and not self.audios and abs(self.main_volume - 1.0) < 1e-6


def carried_atoms(project: dict) -> list:
    """자막을 함께 가져가는 원본 영상 조각 레이어(보이는 트랙만)의 (원본 시간 구간 → 결과 시간 구간). layout.Atom 모양으로 돌려준다."""
    from .layout import Atom

    tmap = track_map(project)
    clips = {c["id"]: c for c in project.get("clips", [])}
    out = []
    for o in project.get("overlays", []):
        t = tmap.get(o.get("track"))
        c = clips.get(o.get("src"))
        if o.get("type") != "clip" or not o.get("carry_subs") or not t or t.get("hidden") or not c:
            continue
        a = c["offset"] + o["src_in"]
        f0 = fr(o["start"])
        out.append(Atom(a, a + o["dur"], 1.0, f0, f0 + max(1, fr(o["dur"]))))
    return out


def build_plan(project: dict) -> Plan:
    """보이는 트랙의 영상 항목과 소리 나는 항목을 모은다(숨김·음소거 트랙은 뺀다)."""
    tracks = tracks_of(project)
    tmap = {t["id"]: t for t in tracks}
    assets = {a["id"]: a for a in project.get("assets", [])}
    clips = {c["id"]: c for c in project.get("clips", [])}
    a1 = next((t for t in tracks if t["kind"] == "audio" and t.get("main")), None)
    plan = Plan(main_volume=0.0 if (a1 and a1.get("muted")) else float(a1["volume"]) if a1 else 1.0)

    def make(o: dict) -> LayerItem | None:
        frames = max(1, fr(o["dur"]))
        if o["type"] == "clip":
            c = clips.get(o["src"])
            if not c:
                return None
            path, src_in = c["path"], o["src_in"]
            meta = (c.get("name", ""), c.get("width", 0), c.get("height", 0), c.get("fps") or 30.0, c["duration"])
        else:
            a = assets.get(o["src"])
            if not a:
                return None
            path, src_in = a["path"], o["src_in"]
            meta = (a.get("name", ""), a.get("width", 0), a.get("height", 0), 30.0, a["duration"])
        return LayerItem(o["id"], o["type"], path, src_in, frames, fr(o["start"]), bool(o.get("has_audio")),
                         float(o.get("volume", 1.0)), float(o.get("fade_in", 0.0)), float(o.get("fade_out", 0.0)),
                         float(o.get("x", 0.5)), float(o.get("y", 0.5)), float(o.get("scale", 1.0)),
                         float(o.get("opacity", 1.0)), o["track"], o["src"], *meta)

    items = [o for o in project.get("overlays", []) if o.get("track") in tmap]
    video_tracks = [t for t in tracks if t["kind"] == "video" and not t.get("main")]
    for t in reversed(video_tracks):            # 맨 아래 트랙부터 → 위 트랙이 마지막(앞)
        if t.get("hidden"):
            continue
        for o in sorted((o for o in items if o["track"] == t["id"]), key=lambda o: o["start"]):
            li = make(o)
            if li:
                plan.visuals.append(li)
                if li.has_audio and li.volume > 0:
                    plan.audios.append(li)
    for t in tracks:
        if t["kind"] != "audio" or t.get("main") or t.get("muted"):
            continue
        for o in sorted((o for o in items if o["track"] == t["id"]), key=lambda o: o["start"]):
            li = make(o)
            if li and li.volume > 0:
                li.volume = li.volume * float(t.get("volume", 1.0))
                plan.audios.append(li)
    plan.end_f = max([li.start_f + li.frames for li in plan.visuals + plan.audios] or [0])
    return plan
