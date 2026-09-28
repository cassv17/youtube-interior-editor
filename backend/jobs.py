"""작업 폴더(workspace/projects/<id>/) 관리와 백그라운드 분석 작업.

폴더 구성:
  sources/      업로드된 영상 사본 (사용자 원본은 건드리지 않는다)
  project.json  클립·컷·자막·스타일 (편집 내용 자동저장 대상)
  levels.json   음량 측정 캐시 (재감지·파형 표시에 재사용)
  proxy*.mp4    편집 화면용 미리보기 영상 (다시 만들 때마다 새 이름. 재생 중인 파일은 윈도우가 잠가서 덮어쓸 수 없음)
"""
import json
import os
import queue
import re
import shutil
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

from .core import export as export_mod, media, project as proj_mod, render, silence

ROOT = Path(__file__).resolve().parents[1]
PROJECTS_DIR = ROOT / "workspace" / "projects"
OUTPUT_DIR = ROOT / "output"
VIDEO_EXT = {".mp4", ".mov", ".m4v"}

_locks: dict[str, threading.RLock] = {}
_status: dict[str, dict] = {}         # 분석 진행 상황
_export_status: dict[str, dict] = {}  # 내보내기 진행 상황
# 분석·내보내기는 CPU를 많이 쓰므로 한 번에 하나씩 처리한다: (종류, 프로젝트 id, 옵션)
_queue: "queue.Queue[tuple[str, str, dict]]" = queue.Queue()


def lock(pid: str) -> threading.RLock:
    return _locks.setdefault(pid, threading.RLock())


def project_dir(pid: str) -> Path:
    if not re.fullmatch(r"[0-9A-Za-z_-]+", pid):
        raise KeyError(pid)
    d = PROJECTS_DIR / pid
    if not (d / "project.json").is_file():
        raise KeyError(pid)
    return d


def load(pid: str) -> dict:
    return proj_mod.load(project_dir(pid) / "project.json")


def save(pid: str, data: dict) -> None:
    data["updated"] = datetime.now().isoformat(timespec="seconds")
    proj_mod.save(data, project_dir(pid) / "project.json")


def list_projects() -> list[dict]:
    out = []
    if PROJECTS_DIR.is_dir():
        for d in sorted(PROJECTS_DIR.iterdir(), reverse=True):
            f = d / "project.json"
            if f.is_file():
                p = proj_mod.load(f)
                row = {k: p.get(k) for k in ("id", "name", "status", "created", "updated", "duration", "completed")}
                row["clips"] = p.get("clip_count") or len(p.get("clips") or p.get("sources") or [])
                out.append(row)
    return out


def _safe_name(name: str) -> str:
    name = Path(name).name
    return re.sub(r'[\\/:*?"<>|]', "_", name) or "video.mp4"


def create_project(uploads: list[tuple[str, object]]) -> dict:
    """uploads: [(원래 파일명, 파일 객체)]. 사본을 sources/에 저장하고 영상 정보를 읽는다."""
    pid = datetime.now().strftime("%Y%m%d-%H%M%S")
    while (PROJECTS_DIR / pid).exists():
        pid += "_1"
    d = PROJECTS_DIR / pid
    (d / "sources").mkdir(parents=True)
    sources = []
    try:
        for i, (name, fobj) in enumerate(uploads):
            if Path(name).suffix.lower() not in VIDEO_EXT:
                raise ValueError(f"지원하지 않는 파일 형식입니다: {name} (mp4/mov/m4v만 가능)")
            dest = d / "sources" / f"{i + 1:02d}_{_safe_name(name)}"
            with open(dest, "wb") as out:
                shutil.copyfileobj(fobj, out, 1024 * 1024)
            info = media.probe(dest)
            info["name"] = name
            sources.append({"sid": f"s{i + 1}", **info})
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    first = Path(sources[0]["name"]).stem
    data = {
        "id": pid,
        "name": f"{first} 외 {len(sources) - 1}개" if len(sources) > 1 else first,
        "status": "uploaded",
        "created": datetime.now().isoformat(timespec="seconds"),
        "sources": sources,
    }
    proj_mod.save(data, d / "project.json")
    return data


# ---------- 분석 작업 ----------

def status(pid: str) -> dict | None:
    return _status.get(pid)


def _set(pid: str, **kw) -> None:
    _status[pid] = {**_status.get(pid, {}), **kw, "time": time.time()}


def start_analysis(pid: str, order: list[str], params: silence.SilenceParams) -> None:
    with lock(pid):
        data = load(pid)
        if data["status"] == "analyzing" and pid in _status:
            raise RuntimeError("이미 분석 중입니다.")
        by_sid = {s["sid"]: s for s in data["sources"]}
        if sorted(order) != sorted(by_sid):
            raise ValueError("클립 순서 정보가 올바르지 않습니다.")
        data["order"] = order
        data["pending_params"] = params.to_dict()
        data["status"] = "analyzing"
        data.pop("error", None)
        save(pid, data)
    _set(pid, stage="대기 중", progress=0.0, detail="")
    _queue.put(("analyze", pid, {}))


def _levels_path(pid: str) -> Path:
    return project_dir(pid) / "levels.json"


def load_levels(pid: str) -> dict:
    f = _levels_path(pid)
    return json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {}


def _run(pid: str) -> None:
    from .core import stt  # 모델 로딩이 무거우므로 필요할 때 불러온다

    d = project_dir(pid)
    data = load(pid)
    by_sid = {s["sid"]: s for s in data["sources"]}
    paths = [by_sid[sid]["path"] for sid in data["order"]]
    original_name = {by_sid[sid]["path"]: by_sid[sid]["name"] for sid in data["order"]}
    params = silence.SilenceParams(**data["pending_params"])

    # 1) 음량 측정 + 무음 컷 (빠름)
    cache = load_levels(pid)
    _set(pid, stage="무음 구간 분석", progress=0.0, detail="")
    built = proj_mod.build_project(
        paths, params, levels_cache=cache,
        progress=lambda i, n, _name: _set(pid, progress=i / n, detail=original_name[paths[i]]))
    for clip in built["clips"]:  # 화면에는 사본 이름(01_...) 대신 원래 파일명을 보여준다
        clip["name"] = original_name.get(clip["path"], clip["name"])
    _levels_path(pid).write_text(json.dumps(cache), encoding="utf-8")

    # 2) 미리보기 영상
    _set(pid, stage="미리보기 영상 만드는 중", progress=0.0, detail="")
    built["proxy"] = _new_proxy_name()
    render.make_proxy(built, d / built["proxy"], progress=lambda f: _set(pid, progress=f))

    # 3) 음성인식 (가장 오래 걸림)
    _set(pid, stage="음성인식 중 (모델 불러오는 중)", progress=0.0, detail="")
    stt.transcribe_project(
        built, stt.SubtitleParams(),
        progress=lambda f, name: _set(pid, stage="음성인식 중", progress=f, detail=name))

    with lock(pid):
        keep = {k: data[k] for k in ("id", "name", "created", "sources", "order", "exports") if k in data}
        save(pid, {**built, **keep, "status": "ready"})
    _set(pid, stage="완료", progress=1.0, detail="")


# ---------- 내보내기 ----------

def export_status(pid: str) -> dict | None:
    return _export_status.get(pid)


def _set_export(pid: str, **kw) -> None:
    _export_status[pid] = {**_export_status.get(pid, {}), **kw, "time": time.time()}


def start_export(pid: str, formats: list[str]) -> None:
    formats = [f for f in formats if f in export_mod.FORMATS]
    if not formats:
        raise ValueError("내려받을 형식을 하나 이상 고르세요.")
    data = load(pid)
    if data["status"] != "ready":
        raise RuntimeError("분석이 끝난 뒤에 내보낼 수 있습니다.")
    if (_export_status.get(pid) or {}).get("state") in ("queued", "running"):
        raise RuntimeError("이미 내보내는 중입니다.")
    _export_status[pid] = {"state": "queued", "progress": 0.0, "result": None, "error": "", "time": time.time()}
    _queue.put(("export", pid, {"formats": formats}))


def _run_export(pid: str, formats: list[str]) -> None:
    """작업은 그대로 두고(원본 클립은 옮기지 않고 복사해) 결과 파일 묶음을 만든다."""
    _set_export(pid, state="running", progress=0.0)
    data = load(pid)  # 시작 시점의 편집 내용으로 만든다
    result = export_mod.build_package(data, OUTPUT_DIR, formats, move_media=False,
                                      progress=lambda f: _set_export(pid, progress=f))
    with lock(pid):
        latest = load(pid)
        latest.setdefault("exports", []).append(result)
        save(pid, latest)
    _set_export(pid, state="done", progress=1.0, result=result)


def _worker() -> None:
    while True:
        kind, pid, opts = _queue.get()
        try:
            if kind == "analyze":
                _run(pid)
            elif kind == "reproxy":
                _run_reproxy(pid)
            elif kind == "finalize":
                _run_finalize(pid, **opts)
            else:
                _run_export(pid, **opts)
        except Exception as e:  # 실패 원인을 화면에 보여주고 다음 작업을 계속한다
            traceback.print_exc()
            if kind in ("analyze", "reproxy"):
                with lock(pid):
                    data = load(pid)
                    data["status"] = "failed"
                    data["error"] = str(e)
                    save(pid, data)
                _set(pid, stage="실패", detail=str(e))
            else:
                _set_export(pid, state="failed", error=str(e))


def inside_output(path: str | Path) -> Path:
    """output 폴더 안의 경로만 허용한다(다른 폴더 파일을 내려받거나 여는 것 방지)."""
    p = Path(path).resolve()
    root = OUTPUT_DIR.resolve()
    if p != root and root not in p.parents:
        raise PermissionError("output 폴더 밖의 파일입니다.")
    return p


def open_output_folder(path: str | None = None) -> None:
    """윈도우 탐색기로 결과 폴더(또는 그 안의 하위 폴더)를 연다."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    target = inside_output(path) if path else OUTPUT_DIR
    os.startfile(target if target.is_dir() else target.parent)  # type: ignore[attr-defined]  (윈도우 전용)


# ---------- 클립 순서·그룹 ----------

def reorder(pid: str, order: list[str], groups: list[dict]) -> dict:
    """클립 순서/그룹을 바꾼다. 순서가 바뀌면 미리보기 영상을 다시 만든다(약 1분/10분 영상)."""
    with lock(pid):
        data = load(pid)
        if data["status"] != "ready":
            raise RuntimeError("분석이 끝난 뒤에 순서를 바꿀 수 있습니다.")
        changed = order != [c["id"] for c in data["clips"]]
        proj_mod.reorder(data, order, groups)
        if changed:
            data["status"] = "analyzing"
        save(pid, data)
    if changed:
        _set(pid, stage="대기 중", progress=0.0, detail="클립 순서 변경")
        _queue.put(("reproxy", pid, {}))
    return data


def _new_proxy_name() -> str:
    return f"proxy_{int(time.time() * 1000)}.mp4"


def proxy_path(pid: str) -> Path:
    data = load(pid)
    return project_dir(pid) / data.get("proxy", "proxy.mp4")


def _cleanup_proxies(pid: str, keep: str) -> None:
    """예전 미리보기 파일을 지운다. 아직 재생 중이라 잠겨 있으면 다음 기회에 지운다."""
    for f in project_dir(pid).glob("proxy*.mp4"):
        if f.name != keep:
            try:
                f.unlink()
            except OSError:
                pass


def start_reproxy(pid: str) -> None:
    """편집 내용은 그대로 두고 미리보기 영상만 다시 만든다(순서 변경 실패 등에서 복구용)."""
    with lock(pid):
        data = load(pid)
        if not data.get("clips"):
            raise RuntimeError("아직 분석되지 않은 프로젝트입니다. '다시 분석'을 사용하세요.")
        data["status"] = "analyzing"
        data.pop("error", None)
        save(pid, data)
    _set(pid, stage="대기 중", progress=0.0, detail="미리보기 다시 만들기")
    _queue.put(("reproxy", pid, {}))


def _run_reproxy(pid: str) -> None:
    data = load(pid)
    _set(pid, stage="바뀐 순서로 미리보기 영상 다시 만드는 중", progress=0.0, detail="")
    name = _new_proxy_name()
    render.make_proxy(data, project_dir(pid) / name, progress=lambda f: _set(pid, progress=f))
    with lock(pid):
        data = load(pid)
        data["proxy"] = name
        data["status"] = "ready"
        data.pop("error", None)
        save(pid, data)
    _cleanup_proxies(pid, name)
    _set(pid, stage="완료", progress=1.0, detail="")


# ---------- 완료 ----------

def start_finalize(pid: str, formats: list[str]) -> None:
    formats = [f for f in formats if f in export_mod.FORMATS]
    if not formats:
        raise ValueError("내려받을 형식을 하나 이상 고르세요.")
    data = load(pid)
    if data["status"] != "ready":
        raise RuntimeError("분석이 끝난 작업만 완료할 수 있습니다.")
    if (_export_status.get(pid) or {}).get("state") in ("queued", "running"):
        raise RuntimeError("이미 내보내는 중입니다.")
    _export_status[pid] = {"state": "queued", "progress": 0.0, "result": None, "error": "",
                           "mode": "finalize", "time": time.time()}
    _queue.put(("finalize", pid, {"formats": formats}))


def _run_finalize(pid: str, formats: list[str]) -> None:
    """작업 기록·업로드 사본을 삭제하는 최종 처리. 원본 클립은 결과 폴더의 media/로 옮긴다."""
    _set_export(pid, state="running", progress=0.0)
    data = load(pid)
    result = export_mod.build_package(data, OUTPUT_DIR, formats, move_media=True,
                                      progress=lambda f: _set_export(pid, progress=f * 0.98))

    result_len = data["duration"] - sum(e - s for s, e in export_mod.merged_cuts(data))
    record = {
        "id": data["id"], "name": data["name"], "created": data["created"], "status": "completed",
        "completed": datetime.now().isoformat(timespec="seconds"),
        "duration": round(result_len, 3), "clip_count": len(data["clips"]),
        "formats": formats, "folder": result["folder"], "files": result["files"],
    }
    # 결과물이 모두 만들어진 뒤에만 작업 기록·업로드 사본을 지운다
    d = project_dir(pid)
    with lock(pid):
        for item in d.iterdir():
            if item.name != "project.json":
                shutil.rmtree(item) if item.is_dir() else item.unlink()
        save(pid, record)
    _status.pop(pid, None)
    _set_export(pid, state="done", progress=1.0, result=record)


def start_worker() -> None:
    threading.Thread(target=_worker, daemon=True, name="analysis-worker").start()


def recover_interrupted() -> None:
    """서버가 분석 도중 꺼졌던 프로젝트는 '중단됨'으로 표시한다(화면에서 다시 시작 가능)."""
    for p in list_projects():
        if p["status"] == "analyzing":
            with lock(p["id"]):
                data = load(p["id"])
                data["status"] = "failed"
                data["error"] = "분석 도중 프로그램이 종료되었습니다. 다시 시작해 주세요."
                save(p["id"], data)


def waveform(pid: str) -> dict:
    """타임라인 전체의 20ms 단위 음량(dB, 정수). 클립 길이에 맞춰 자르거나 채운다."""
    data = load(pid)
    cache = load_levels(pid)
    out: list[int] = []
    for clip in data["clips"]:
        n = round(clip["duration"] / silence.FRAME_SEC)
        lv = [round(x) for x in cache.get(clip["path"], [])[:n]]
        out += lv + [int(silence.SILENT_DB)] * (n - len(lv))
    return {"frame_sec": silence.FRAME_SEC, "db": out}


# ---------- 편집 내용 저장 ----------

def _num(v, lo: float, hi: float) -> float:
    return round(min(max(float(v), lo), hi), 3)


def _owner(data: dict, item: dict, start: float) -> str:
    """항목이 기록해 둔 클립 안에 여전히 있으면 그 클립, 아니면 시작 시각으로 판정한다."""
    c = next((c for c in data["clips"] if c["id"] == item.get("clip_id")), None)
    if c and c["offset"] - 1e-3 <= start < c["offset"] + c["duration"] + 1e-3:
        return c["id"]
    return proj_mod.clip_at(data, start)["id"]


def apply_edits(pid: str, body: dict) -> dict:
    """화면에서 보낸 컷·자막·스타일을 검증해 저장한다."""
    with lock(pid):
        data = load(pid)
        if data["status"] != "ready":
            raise RuntimeError("분석이 끝난 뒤에 편집할 수 있습니다.")
        dur = data["duration"]
        if "cuts" in body:
            cuts = []
            for c in body["cuts"]:
                s, e = _num(c["start"], 0, dur), _num(c["end"], 0, dur)
                if e - s < 0.01:
                    continue
                cuts.append({**c, "start": s, "end": e, "enabled": bool(c.get("enabled", True)),
                             "clip_id": _owner(data, c, s),
                             "origin": c.get("origin", "user"),
                             "review_reasons": list(c.get("review_reasons", [])),
                             "needs_review": bool(c.get("needs_review", False))})
            data["cuts"] = sorted(cuts, key=lambda c: c["start"])
        if "subtitles" in body:
            subs = []
            for s in body["subtitles"]:
                st, en = _num(s["start"], 0, dur), _num(s["end"], 0, dur)
                text = str(s.get("text", "")).strip()
                if en - st < 0.05 or not text:
                    continue
                subs.append({**s, "start": st, "end": en, "text": text,
                             "clip_id": _owner(data, s, st),
                             "words": list(s.get("words", []))})
            data["subtitles"] = sorted(subs, key=lambda s: s["start"])
        if "style" in body:
            data["style"] = {k: body["style"].get(k, v) for k, v in proj_mod.DEFAULT_STYLE.items()}
        save(pid, data)
        return data


def redetect(pid: str, params: silence.SilenceParams) -> dict:
    with lock(pid):
        data = load(pid)
        if data["status"] != "ready":
            raise RuntimeError("분석이 끝난 뒤에 다시 감지할 수 있습니다.")
        cache = load_levels(pid)
        proj_mod.redetect(data, params, levels_cache=cache)
        save(pid, data)
        return data
