"""로컬 웹 서버. 브라우저 화면(frontend/dist)과 API를 같은 주소(http://localhost:8000)로 제공한다.

실행: .venv\\Scripts\\python -m uvicorn backend.server:app --port 8000
"""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import jobs
from .core import silence
from .core.media import MediaError

DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_app):
    jobs.recover_interrupted()
    jobs.start_worker()
    yield


app = FastAPI(title="영상 자동편집", lifespan=lifespan)


def _get(pid: str) -> dict:
    try:
        return jobs.load(pid)
    except KeyError:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다.")


def _params(body: dict) -> silence.SilenceParams:
    try:
        th = body.get("threshold", "auto")
        return silence.SilenceParams(
            threshold=th if th == "auto" else float(th),
            min_silence=float(body.get("min_silence", 0.6)),
            pad=float(body.get("pad", 0.15)),
        )
    except (TypeError, ValueError):
        raise HTTPException(400, "무음 설정값이 올바르지 않습니다.")


@app.get("/api/projects")
def list_projects():
    return jobs.list_projects()


@app.post("/api/projects")
def create_project(files: list[UploadFile]):
    if not files:
        raise HTTPException(400, "영상 파일을 선택해 주세요.")
    try:
        return jobs.create_project([(f.filename or "video.mp4", f.file) for f in files])
    except (ValueError, MediaError) as e:
        raise HTTPException(400, str(e))


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    data = _get(pid)
    return {**data, "job": jobs.status(pid), "export_job": jobs.export_status(pid)}


@app.post("/api/projects/{pid}/start")
def start(pid: str, body: dict):
    _get(pid)
    try:
        jobs.start_analysis(pid, list(body.get("order", [])), _params(body.get("silence", {})))
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.put("/api/projects/{pid}/edits")
def save_edits(pid: str, body: dict):
    _get(pid)
    try:
        data = jobs.apply_edits(pid, body)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(400, f"편집 내용이 올바르지 않습니다: {e}")
    return {"ok": True, "updated": data["updated"]}


@app.post("/api/projects/{pid}/redetect")
def redetect(pid: str, body: dict):
    _get(pid)
    try:
        return jobs.redetect(pid, _params(body))
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@app.post("/api/projects/{pid}/export")
def start_export(pid: str, body: dict):
    _get(pid)
    try:
        jobs.start_export(pid, formats=list(body.get("formats", [])))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


@app.post("/api/open-output")
def open_output(body: dict | None = None):
    try:
        jobs.open_output_folder((body or {}).get("path"))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except (AttributeError, OSError) as e:
        raise HTTPException(500, f"폴더를 열 수 없습니다: {e}")
    return {"ok": True}


@app.get("/api/download")
def download(path: str):
    try:
        f = jobs.inside_output(path)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    if not f.is_file():
        raise HTTPException(404, "파일이 없습니다. 옮기거나 지웠는지 확인하세요.")
    return FileResponse(f, filename=f.name)


@app.post("/api/projects/{pid}/reorder")
def reorder(pid: str, body: dict):
    _get(pid)
    try:
        return jobs.reorder(pid, list(body.get("order", [])), list(body.get("groups", [])))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@app.post("/api/projects/{pid}/reproxy")
def reproxy(pid: str):
    _get(pid)
    try:
        jobs.start_reproxy(pid)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


@app.post("/api/projects/{pid}/finalize")
def finalize(pid: str, body: dict):
    _get(pid)
    try:
        jobs.start_finalize(pid, list(body.get("formats", [])))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


@app.get("/api/projects/{pid}/waveform")
def waveform(pid: str):
    _get(pid)
    return jobs.waveform(pid)


@app.get("/api/projects/{pid}/proxy.mp4")
def proxy(pid: str):
    _get(pid)
    f = jobs.proxy_path(pid)
    if not f.is_file():
        raise HTTPException(404, "미리보기 영상이 아직 없습니다.")
    return FileResponse(f, media_type="video/mp4")


if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
