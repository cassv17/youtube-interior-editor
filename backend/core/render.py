"""여러 클립을 하나로 이어붙여 인코딩한다. 미리보기(프록시)와 최종 내보내기가 같은 규칙을 쓴다.

클립 정규화 규칙(타임라인과 1:1로 맞추기 위함):
- 영상: 30fps 고정, 출력 해상도에 맞춰 비율 유지 + 검은 여백, 길이는 정확히 clip.duration
- 음성: 48kHz 스테레오, 부족하면 무음으로 채우고 clip.duration에서 자름
- 회전 정보는 ffmpeg가 디코딩할 때 자동 반영한다
"""
import re
import subprocess
import tempfile
from pathlib import Path

from .media import NO_WINDOW, MediaError, ffmpeg, run

AUDIO_RATE = 48000
FADE = 0.01  # 컷 이음새마다 넣는 음성 페이드(초). '틱' 소리 방지

_qsv_available: bool | None = None


def qsv_available() -> bool:
    """인텔 내장 그래픽의 하드웨어 인코더(h264_qsv)를 쓸 수 있는지 확인한다.

    아주 짧은 테스트 영상을 실제로 인코딩해 봐서 판단하고, 결과는 서버가 켜져 있는 동안 재사용한다
    (매번 확인하면 느리므로). GPU가 없거나 드라이버가 없으면 False가 되어 CPU 인코더를 쓴다.
    """
    global _qsv_available
    if _qsv_available is None:
        try:
            run([ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "color=black:s=64x64:d=0.2",
                 "-c:v", "h264_qsv", "-f", "null", "-"])
            _qsv_available = True
        except MediaError:
            _qsv_available = False
    return _qsv_available


def disable_qsv() -> None:
    """실제 인코딩 중 h264_qsv가 실패하면 호출한다. 이후에는 CPU 인코더만 쓴다."""
    global _qsv_available
    _qsv_available = False


def video_encode_args() -> list[str]:
    """최종 인코딩(내보내기·완료)에 쓸 비디오 인코더 옵션.

    가능하면 인텔 하드웨어 가속(h264_qsv)을 쓴다 — 이 PC에서 실측 결과 화질·용량 차이 없이
    약 2배 빠르다. 안 되면 기존 CPU 인코더(libx264)로 돌아간다.
    """
    if qsv_available():
        return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "22"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]


def even(n: float) -> int:
    return max(2, int(round(n / 2)) * 2)


def _video_chain(inp: str, clip: dict, w: int, h: int, fps: int) -> str:
    return (f"[{inp}]setpts=PTS-STARTPTS,fps={fps},"
            f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,"
            f"tpad=stop_mode=clone:stop_duration=1,trim=duration={clip['duration']:.6f},"
            f"setpts=PTS-STARTPTS")


def _audio_chain(inp: str, clip: dict) -> str:
    return (f"[{inp}]aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"asetpts=PTS-STARTPTS,apad,atrim=duration={clip['duration']:.6f},asetpts=PTS-STARTPTS")


def build_inputs_and_graph(project: dict, segments: dict[str, list[tuple[float, float]]] | None,
                           w: int, h: int, video_filter: str = "") -> tuple[list[str], str, float]:
    """ffmpeg 입력 인자, filter_complex 문자열, 결과 길이(초)를 만든다.

    segments: {clip_id: [(시작, 끝), ...]} 클립 기준 시간의 '남길' 구간. None이면 클립 전체.
    구간 경계는 1/fps 단위로 맞춰져 있어야 영상 프레임 수와 음성 길이가 정확히 일치한다.
    """
    fps = project["output"]["fps"]
    args: list[str] = []
    parts: list[str] = []
    outs: list[str] = []
    total = 0.0
    n_in = 0
    for k, clip in enumerate(project["clips"]):
        segs = [(0.0, clip["duration"])] if segments is None else segments.get(clip["id"], [])
        segs = [(s, e) for s, e in segs if e - s >= 1 / fps - 1e-6]
        if not segs:
            continue
        args += ["-i", clip["path"]]
        vi = n_in
        n_in += 1
        if clip["has_audio"]:
            ai = f"{vi}:a:0"
        else:
            args += ["-f", "lavfi", "-t", f"{clip['duration']:.6f}",
                     "-i", f"anullsrc=r={AUDIO_RATE}:cl=stereo"]
            ai = f"{n_in}:a"
            n_in += 1

        whole = segments is None or segs == [(0.0, clip["duration"])]
        v = _video_chain(f"{vi}:v:0", clip, w, h, fps)
        a = _audio_chain(ai, clip)
        if whole:
            parts.append(f"{v}[v{k}]")
            parts.append(f"{a}[a{k}]")
        else:
            # 영상: 남길 프레임만 고른다(한 번만 디코딩하므로 메모리가 적게 든다).
            # 프레임 시각 k/fps가 [s, e)에 들면 남긴다. 부동소수 오차로 경계 프레임이 빠지지 않게
            # 양쪽 기준을 반 프레임 앞당긴다 → 구간마다 정확히 (e-s)*fps 프레임.
            half = 1 / fps / 2
            expr = "+".join(f"between(t,{s - half:.6f},{e - half:.6f})" for s, e in segs)
            parts.append(f"{v},select='{expr}',setpts=N/{fps}/TB[v{k}]")
            # 음성: 구간별로 잘라 이음새마다 짧게 페이드
            parts.append(f"{a},asplit={len(segs)}" + "".join(f"[a{k}_{j}]" for j in range(len(segs))))
            for j, (s, e) in enumerate(segs):
                d = e - s
                fade = min(FADE, d / 4)
                parts.append(f"[a{k}_{j}]atrim={s:.6f}:{e:.6f},asetpts=PTS-STARTPTS,"
                             f"afade=t=in:d={fade:.4f},afade=t=out:st={d - fade:.6f}:d={fade:.4f}[a{k}s{j}]")
            parts.append("".join(f"[a{k}s{j}]" for j in range(len(segs)))
                         + f"concat=n={len(segs)}:v=0:a=1[a{k}]")
        outs.append(k)
        total += sum(e - s for s, e in segs)

    if not outs:
        raise MediaError("남길 구간이 없습니다. 컷이 영상 전체를 덮고 있습니다.")
    parts.append("".join(f"[v{k}][a{k}]" for k in outs) + f"concat=n={len(outs)}:v=1:a=1[vc][ac]")
    parts.append(f"[vc]{video_filter or 'null'}[vout]")
    return args, ";\n".join(parts), total


def run_ffmpeg(input_args: list[str], graph: str, output_args: list[str], out_path: Path,
               total: float, progress=None, files: dict[str, str] | None = None) -> None:
    """filter_complex를 파일로 넘겨(긴 컷 목록 대비) 인코딩하고, 진행률(0~1)을 알린다.

    files({이름: 내용})는 임시 폴더에 써 두고 그 폴더에서 ffmpeg를 실행한다.
    자막 필터에 윈도우 경로(C:\\...)를 넣으면 이스케이프가 까다로워서, 파일 이름만 쓰기 위함이다.
    """
    out_path = Path(out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_out = out_path.with_name(out_path.stem + ".part" + out_path.suffix)
    with tempfile.TemporaryDirectory() as td:
        for name, content in (files or {}).items():
            (Path(td) / name).write_text(content, encoding="utf-8")
        graph_file = Path(td) / "graph.txt"
        graph_file.write_text(graph, encoding="utf-8")
        err_file = Path(td) / "stderr.txt"
        cmd = [ffmpeg(), "-y", "-hide_banner", "-nostats", "-progress", "pipe:1",
               *input_args, "-/filter_complex", str(graph_file),
               "-map", "[vout]", "-map", "[ac]", *output_args, str(tmp_out)]
        with open(err_file, "wb") as err:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, cwd=td, creationflags=NO_WINDOW)
            for line in proc.stdout:
                m = re.match(rb"out_time_us=(\d+)", line)
                if m and progress and total > 0:
                    progress(min(int(m.group(1)) / 1e6 / total, 1.0))
            proc.stdout.close()
            proc.wait()
        if proc.returncode != 0:
            tmp_out.unlink(missing_ok=True)
            msg = err_file.read_text(encoding="utf-8", errors="replace")[-1200:]
            raise MediaError(f"인코딩 실패: {msg}")
    tmp_out.replace(out_path)  # 완성된 뒤에만 최종 이름으로 바꾼다


def make_proxy(project: dict, out_path: Path, progress=None, height: int = 540) -> Path:
    """편집 화면용 가벼운 미리보기 영상(H.264). 원본 화질과 무관하며 내보내기에는 쓰지 않는다."""
    ow, oh = project["output"]["width"], project["output"]["height"]
    h = min(height, oh)
    w = even(ow * h / oh)
    h = even(h)
    inputs, graph, total = build_inputs_and_graph(project, None, w, h)
    run_ffmpeg(inputs, graph, [
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-g", "15",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
    ], out_path, total, progress)
    return out_path
