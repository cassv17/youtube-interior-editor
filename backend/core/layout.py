"""결과 배치(layout): 조각마다 결과 영상에서의 위치를 따로 갖는다.

frontend/src/layout.ts 와 같은 식으로 계산한다(모든 길이는 30fps 프레임 정수). 화면에서 본 위치와
만들어진 영상·자막·XML의 위치가 어긋나지 않게 하기 위해서다.

- 조각(item): 원본 타임라인(P)의 구간 [a, b] + 앞 빈칸(gap, 초). 저장되는 것은 순서와 빈칸뿐이고 절대 위치는 계산한다.
- 배치는 '컷·나눈 지점으로 정해지는 남는 구간'(kept_pieces)을 정확히 한 번씩 덮어야 한다. 아니면 무시하고 기본 배치를 쓴다.
"""
from dataclasses import dataclass

FPS = 30
EPS = 1e-6
TOL = 0.5 / FPS  # 조각 경계가 이 이내로 같으면 같은 것으로 본다


def grid(t: float) -> float:
    return round(t * FPS) / FPS


def fr(t: float) -> int:
    return round(t * FPS)


def kept_pieces(project: dict) -> list[tuple[float, float]]:
    """켜진 컷을 뺀 나머지를 나눈 지점·클립 경계에서 쪼갠 구간(원본 시간). 화면의 computePieces와 같다."""
    from . import export  # 순환 참조 방지

    dur = project["duration"]
    kept: list[tuple[float, float]] = []
    cur = 0.0
    for s, e in export.merged_cuts(project):
        if s > cur + 1e-4:
            kept.append((cur, min(s, dur)))
        cur = max(cur, e)
    if cur < dur - 1e-4:
        kept.append((cur, dur))
    marks = sorted({grid(t) for t in project.get("splits", [])} |
                   {grid(c["offset"]) for c in project["clips"][1:]})
    pieces = []
    for s, e in kept:
        a = s
        for m in marks:
            if a + 1e-4 < m < e - 1e-4:
                pieces.append((a, m))
                a = m
        pieces.append((a, e))
    return [(a, b) for a, b in pieces if b - a >= 1 / FPS - 1e-4]


def items_of(project: dict) -> list[dict] | None:
    """저장된 배치를 검증해 격자에 맞춘 조각 목록으로 돌려준다. 없거나 기본이거나 맞지 않으면 None(기본 배치)."""
    raw = project.get("layout")
    if not raw or not isinstance(raw, list):
        return None
    items = []
    for x in raw:
        try:
            a, b, gap = grid(float(x["a"])), grid(float(x["b"])), max(0.0, grid(float(x.get("gap", 0))))
        except (KeyError, TypeError, ValueError):
            return None
        if b - a < 1 / FPS - 1e-6:
            return None
        items.append({"id": str(x.get("id", "")), "a": a, "b": b, "gap": gap})
    pieces = kept_pieces(project)
    if len(items) != len(pieces):
        return None
    left = list(pieces)
    for it in items:
        k = next((i for i, (a, b) in enumerate(left) if abs(a - it["a"]) <= TOL and abs(b - it["b"]) <= TOL), -1)
        if k < 0:
            return None
        left.pop(k)
    if is_default(items):
        return None
    return items


def is_default(items: list[dict]) -> bool:
    for i, it in enumerate(items):
        if it["gap"] > EPS:
            return False
        if i > 0 and it["a"] < items[i - 1]["a"] + EPS:
            return False
    return True


@dataclass
class Atom:
    a: float          # 원본(P) 시간
    b: float
    speed: float
    f0: int           # 결과 영상 프레임
    f1: int


@dataclass
class Placed:
    id: str
    a: float
    b: float
    f0: int
    f1: int
    atoms: list[Atom]


def atoms_of(a: float, b: float, speeds: list[tuple[float, float, float]], start_frame: int) -> list[Atom]:
    atoms: list[Atom] = []
    f = start_frame

    def push(x: float, y: float, speed: float) -> None:
        nonlocal f
        src = fr(y - x)
        if src <= 0:
            return
        out = max(1, round(src / speed))
        atoms.append(Atom(x, y, speed, f, f + out))
        f += out

    cur, end = grid(a), grid(b)
    for rs, re_, sp in speeds:
        if re_ <= cur + EPS or rs >= end - EPS:
            continue
        if rs > cur + EPS:
            push(cur, rs, 1.0)
        lo, hi = max(cur, rs), min(end, re_)
        push(lo, hi, sp)
        cur = hi
    if end - cur > EPS:
        push(cur, end, 1.0)
    return atoms


def place(items: list[dict], speeds: list[tuple[float, float, float]]) -> tuple[list[Placed], int]:
    placed: list[Placed] = []
    cursor = 0
    for it in items:
        start = cursor + max(0, fr(it["gap"]))
        atoms = atoms_of(it["a"], it["b"], speeds, start)
        end = atoms[-1].f1 if atoms else start
        placed.append(Placed(it["id"], it["a"], it["b"], start, end, atoms))
        cursor = end
    return placed, cursor


def default_items(project: dict) -> list[dict]:
    return [{"id": f"pc-{fr(a)}", "a": grid(a), "b": grid(b), "gap": 0.0} for a, b in kept_pieces(project)]


def instances(placed: list[Placed], subs: list[dict], extra: list | None = None) -> list[tuple[float, float, str]]:
    """조각을 따라가는 자막을 결과 시간(초)으로 옮긴다. 분리된(free) 자막은 호출하는 쪽에서 따로 다룬다.
    extra: 자막을 함께 가져가는 다른 레이어의 조각(Atom 모양)."""
    atoms = [at for it in placed for at in it.atoms] + list(extra or [])
    out: list[tuple[float, float, str]] = []
    for s in subs:
        if s.get("free"):
            continue
        parts: list[list[float]] = []
        for at in atoms:
            lo, hi = max(s["start"], at.a), min(s["end"], at.b)
            if hi - lo <= EPS:
                continue
            r = (at.f1 - at.f0) / FPS / (at.b - at.a)
            parts.append([at.f0 / FPS + (lo - at.a) * r, at.f0 / FPS + (hi - at.a) * r])
        parts.sort()
        merged: list[list[float]] = []
        for p in parts:
            if merged and p[0] <= merged[-1][1] + 1e-4:
                merged[-1][1] = max(merged[-1][1], p[1])
            else:
                merged.append(p)
        out += [(e0, e1, s["text"]) for e0, e1 in merged]
    return sorted(out)
