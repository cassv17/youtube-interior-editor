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


def atempo_chain(speed: float) -> str:
    """ffmpeg atempo는 한 번에 0.5~2배까지만 되므로 2배를 넘으면 나눠서 건다."""
    factors = [2.0, speed / 2] if speed > 2 else [speed]
    return ",".join(f"atempo={f:.6f}" for f in factors)


def _retime_expr(pieces: list[tuple[float, float, float]], fps: int) -> str:
    """select를 거친 프레임 번호(N) → 배속을 반영한 시각(초). 조각마다 기울기가 다른 구간별 직선이다."""
    starts, base, n_total = [], [], 0
    out_t = 0.0
    for s, e, sp in pieces:
        n = round((e - s) * fps)
        starts.append(n_total)
        base.append(out_t)
        n_total += n
        out_t += n / (fps * sp)
    expr = f"{base[-1]:.9f}+(N-{starts[-1]})/({fps}*{pieces[-1][2]:.6f})"
    for i in range(len(pieces) - 2, -1, -1):
        expr = f"if(lt(N,{starts[i + 1]}),{base[i]:.9f}+(N-{starts[i]})/({fps}*{pieces[i][2]:.6f}),{expr})"
    return expr


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

    segments: {clip_id: [(시작, 끝) 또는 (시작, 끝, 배속), ...]} 클립 기준 시간의 '남길' 구간. None이면 클립 전체.
    배속이 1이 아닌 조각이 있는 클립은 그 클립만 배속 경로로 만든다(영상은 프레임을 골라 시각을 다시 매기고,
    음성은 atempo). 클립 길이는 영상 프레임 수에 맞춰 음성을 자른다.
    구간 경계는 1/fps 단위로 맞춰져 있어야 영상 프레임 수와 음성 길이가 정확히 일치한다.
    """
    fps = project["output"]["fps"]
    args: list[str] = []
    parts: list[str] = []
    outs: list[str] = []
    total = 0.0
    n_in = 0
    for k, clip in enumerate(project["clips"]):
        raw = [(0.0, clip["duration"])] if segments is None else segments.get(clip["id"], [])
        trip = [(x[0], x[1], x[2] if len(x) > 2 else 1.0) for x in raw]
        trip = [(s, e, sp) for s, e, sp in trip if e - s >= 1 / fps - 1e-6]
        segs = [(s, e) for s, e, _ in trip]
        retimed = any(abs(sp - 1.0) > 1e-6 for _, _, sp in trip)
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

        whole = not retimed and (segments is None or segs == [(0.0, clip["duration"])])
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
            if retimed:
                # 고른 프레임에 배속을 반영한 시각을 다시 매기고 30fps로 맞춘다(빠르면 솎고 느리면 겹친다).
                out_sec = sum(round((e - s) * fps) / (fps * sp) for s, e, sp in trip)
                frames = round(out_sec * fps)
                parts.append(f"{v},select='{expr}',setpts='({_retime_expr(trip, fps)})/TB',fps={fps},"
                             f"tpad=stop_mode=clone:stop_duration=1,trim=end_frame={frames},setpts=N/{fps}/TB[v{k}]")
            else:
                parts.append(f"{v},select='{expr}',setpts=N/{fps}/TB[v{k}]")
            # 음성: 구간별로 잘라 이음새마다 짧게 페이드(배속 조각은 atempo)
            parts.append(f"{a},asplit={len(segs)}" + "".join(f"[a{k}_{j}]" for j in range(len(segs))))
            for j, (s, e, sp) in enumerate(trip):
                d = e - s
                fade = min(FADE, d / 4)
                tempo = f",{atempo_chain(sp)}" if abs(sp - 1.0) > 1e-6 else ""
                parts.append(f"[a{k}_{j}]atrim={s:.6f}:{e:.6f},asetpts=PTS-STARTPTS,"
                             f"afade=t=in:d={fade:.4f},afade=t=out:st={d - fade:.6f}:d={fade:.4f}{tempo}[a{k}s{j}]")
            fit = f",apad,atrim=duration={frames / fps:.6f},asetpts=PTS-STARTPTS" if retimed else ""
            parts.append("".join(f"[a{k}s{j}]" for j in range(len(segs)))
                         + f"concat=n={len(segs)}:v=0:a=1{fit}[a{k}]")
        outs.append(k)
        total += frames / fps if retimed else sum(e - s for s, e in segs)

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


def build_layout_graph(project: dict, sequence: list[tuple], w: int, h: int,
                       video_filter: str = "") -> tuple[list[str], str, float]:
    """결과 배치(순서 바꿈·빈칸)를 만든다. sequence 항목:
      ("gap", 프레임수)
      ("atom", 클립, 클립 기준 시작(초), 끝(초), 배속, 결과 프레임수)

    조각마다 같은 파일을 따로 열어(-ss/-t) 필요한 부분만 읽는다. 순서가 뒤섞여도 한쪽으로 프레임이 쌓이지 않아
    긴 영상에서도 메모리가 안정적이다. 길이는 모두 프레임 정수라 화면에서 본 위치와 영상 위치가 같다.
    """
    fps = project["output"]["fps"]
    args: list[str] = []
    parts: list[str] = []
    labels: list[str] = []
    n_in = 0
    total_frames = 0
    afmt = f"aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo"
    for i, item in enumerate(sequence):
        if item[0] == "gap":
            n = int(item[1])
            d = n / fps
            parts.append(f"color=c=black:s={w}x{h}:r={fps}:d={d + 1:.6f},format=yuv420p,setsar=1,"
                         f"trim=end_frame={n},setpts=N/{fps}/TB[v{i}]")
            parts.append(f"anullsrc=r={AUDIO_RATE}:cl=stereo,{afmt},atrim=duration={d:.6f},asetpts=PTS-STARTPTS[a{i}]")
        else:
            _, clip, s, e, speed, n = item
            n = int(n)
            d = n / fps
            args += ["-ss", f"{s:.6f}", "-t", f"{e - s + 0.2:.6f}", "-i", clip["path"]]
            vi = n_in
            n_in += 1
            parts.append(f"[{vi}:v:0]setpts=(PTS-STARTPTS)/{speed:.6f},fps={fps},"
                         f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                         f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,"
                         f"tpad=stop_mode=clone:stop_duration=1,trim=end_frame={n},setpts=N/{fps}/TB[v{i}]")
            fade = min(FADE, d / 4)
            tail = (f"apad,atrim=duration={d:.6f},asetpts=PTS-STARTPTS,"
                    f"afade=t=in:d={fade:.4f},afade=t=out:st={d - fade:.6f}:d={fade:.4f}[a{i}]")
            tempo = f",{atempo_chain(speed)}" if abs(speed - 1.0) > 1e-6 else ""
            if clip["has_audio"]:
                parts.append(f"[{vi}:a:0]{afmt},asetpts=PTS-STARTPTS{tempo},{tail}")
            else:
                parts.append(f"anullsrc=r={AUDIO_RATE}:cl=stereo,{afmt},atrim=duration={d + 0.5:.6f},"
                             f"asetpts=PTS-STARTPTS,{tail}")
        total_frames += n
        labels.append(f"[v{i}][a{i}]")
    if not labels:
        raise MediaError("남길 구간이 없습니다. 컷이 영상 전체를 덮고 있습니다.")
    parts.append("".join(labels) + f"concat=n={len(labels)}:v=1:a=1[vc][ac]")
    parts.append(f"[vc]{video_filter or 'null'}[vout]")
    return args, ";\n".join(parts), total_frames / fps
