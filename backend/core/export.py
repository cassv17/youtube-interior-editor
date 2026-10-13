"""내보내기: 확정된 컷을 반영해 영상을 만들고, 자막 시간을 결과 영상 기준으로 다시 계산한다.

- 적용(enabled) 컷을 합친 뒤 1/30초 격자에 맞춘다. 미리보기와 같은 격자라 프레임 수와 음성 길이가 정확히 맞는다.
- 자막 시간 변환: 결과 시간 = 원래 시간 - (그 앞에서 잘린 시간의 합).
  컷 안에 완전히 들어간 자막은 빠지고, 컷에 걸친 자막은 잘린 만큼 짧아진다.
- 구간 배속(speed_ranges): 결과 시간 = 컷으로 남은 구간을 (길이 ÷ 배속)으로 더한 값. 자막 시간도 같은 식으로 옮긴다.
- 원본은 읽기만 하고, 결과는 output 폴더에 새 파일로 만든다(기존 파일 덮어쓰기 없음).
"""
import re
import shutil
from datetime import datetime
from pathlib import Path

from . import layers as layers_mod, layout as layout_mod, nle, render
from .media import MediaError

MIN_SPEED, MAX_SPEED = 0.5, 4.0
MIN_SUB = 0.2  # 컷 반영 후 이보다 짧아진 자막은 뺀다(읽을 수 없는 길이)
# ASS(libass)의 Fontsize는 글자 크기(em)가 아니라 줄 높이(winAscent+winDescent) 기준이다.
# 맑은 고딕(malgun.ttf)은 (2229+495)/2048 = 1.33. 이 비율을 곱해야 미리보기(CSS font-size)와 같은 크기가 된다.
FONT_CELL_RATIO = 1.33


def _grid(t: float, fps: int) -> float:
    return round(t * fps) / fps


def merged_cuts(project: dict) -> list[tuple[float, float]]:
    """적용된 컷을 합치고 프레임 격자에 맞춘 목록(타임라인 시간)."""
    fps = project["output"]["fps"]
    spans = sorted((_grid(c["start"], fps), _grid(c["end"], fps))
                   for c in project["cuts"] if c.get("enabled", True))
    out: list[list[float]] = []
    for s, e in spans:
        s, e = max(0.0, s), min(project["duration"], e)
        if e <= s:
            continue
        if out and s <= out[-1][1] + 1e-6:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def keep_segments(project: dict, cuts: list[tuple[float, float]]) -> dict[str, list[tuple[float, float]]]:
    """클립별 '남길 구간'(클립 기준 시간). render.build_inputs_and_graph에 그대로 넘긴다."""
    fps = project["output"]["fps"]
    result = {}
    for clip in project["clips"]:
        c0 = _grid(clip["offset"], fps)
        c1 = _grid(clip["offset"] + clip["duration"], fps)
        pieces = [(c0, c1)]
        for s, e in cuts:
            nxt = []
            for ps, pe in pieces:
                if e <= ps or s >= pe:
                    nxt.append((ps, pe))
                    continue
                if s > ps:
                    nxt.append((ps, s))
                if e < pe:
                    nxt.append((e, pe))
            pieces = nxt
        result[clip["id"]] = [(round(s - c0, 6), round(e - c0, 6)) for s, e in pieces if e - s > 1e-6]
    return result


def merged_speeds(project: dict) -> list[tuple[float, float, float]]:
    """배속 구간(타임라인 시간)을 프레임 격자에 맞추고 겹침을 없앤 목록. 1배속은 뺀다."""
    fps = project["output"]["fps"]
    spans = []
    for r in project.get("speed_ranges", []):
        try:
            sp = min(max(float(r["speed"]), MIN_SPEED), MAX_SPEED)
            s, e = _grid(float(r["start"]), fps), _grid(float(r["end"]), fps)
        except (KeyError, TypeError, ValueError):
            continue
        spans.append((max(0.0, s), min(project["duration"], e), sp))
    out: list[tuple[float, float, float]] = []
    for s, e, sp in sorted(spans):
        if out:
            s = max(s, out[-1][1])  # 겹치면 뒤 구간을 앞 구간 끝에서 시작
        if e - s < 1 / fps - 1e-6 or abs(sp - 1.0) < 1e-6:
            continue
        out.append((s, e, sp))
    return out


def keep_pieces(project: dict, cuts: list[tuple[float, float]],
                speeds: list[tuple[float, float, float]]) -> dict[str, list[tuple[float, float, float]]]:
    """클립별 '남길 구간'을 배속 경계에서 나눈 (시작, 끝, 배속) 목록(클립 기준 시간)."""
    fps = project["output"]["fps"]
    offsets = {c["id"]: _grid(c["offset"], fps) for c in project["clips"]}
    result = {}
    for cid, segs in keep_segments(project, cuts).items():
        c0 = offsets[cid]
        pieces = []
        for s, e in segs:
            cur = s
            for rs, re_, sp in speeds:
                rs, re_ = rs - c0, re_ - c0
                if re_ <= cur + 1e-6 or rs >= e - 1e-6:
                    continue
                if rs > cur + 1e-6:
                    pieces.append((cur, rs, 1.0))
                lo, hi = max(cur, rs), min(e, re_)
                pieces.append((lo, hi, sp))
                cur = hi
            if e - cur > 1e-6:
                pieces.append((cur, e, 1.0))
        result[cid] = [(round(s, 6), round(e, 6), sp) for s, e, sp in pieces if e - s > 1e-6]
    return result


def map_time(t: float, cuts: list[tuple[float, float]],
             speeds: list[tuple[float, float, float]] | None = None) -> float:
    """타임라인 시간 → 결과 영상 시간. 컷 안의 시간은 그 컷이 시작되던 자리로 간다.
    배속 구간에서는 시간이 (길이 ÷ 배속)만큼만 흐른다."""
    if not speeds:
        removed = 0.0
        for s, e in cuts:
            if t >= e:
                removed += e - s
            elif t > s:
                removed += t - s
                break
            else:
                break
        return t - removed
    # 경계: 컷 시작/끝, 배속 시작/끝으로 나눈 조각마다 (배속, 컷 여부)가 일정하다
    marks = sorted({0.0, t, *[x for s, e in cuts for x in (s, e)], *[x for s, e, _ in speeds for x in (s, e)]})
    out = 0.0
    for a, b in zip(marks, marks[1:]):
        if b > t + 1e-9:
            break
        mid = (a + b) / 2
        if any(s <= mid < e for s, e in cuts):
            continue
        sp = next((r[2] for r in speeds if r[0] <= mid < r[1]), 1.0)
        out += (b - a) / sp
    return out


def _finish_subtitles(raw: list[tuple]) -> list[dict]:
    """결과 시간으로 옮긴 자막을 정리한다: 너무 짧거나 빈 것은 빼고, 같은 레이어 안에서는 겹치지 않게 한다.
    raw 항목: (시작, 끝, 글, 트랙 id). 레이어가 다르면 같은 시간에 겹쳐 보여도 된다."""
    by_track: dict[str, list[tuple]] = {}
    for s, e, text, tid in raw:
        by_track.setdefault(tid, []).append((s, e, text))
    out: list[dict] = []
    for tid, items in by_track.items():
        prev: dict | None = None
        for s, e, text in sorted(items):
            if e - s < MIN_SUB or not text.strip():
                continue
            if prev and s < prev["end"]:  # 컷 때문에 붙은 자막끼리 겹치지 않게
                s = prev["end"]
                if e - s < MIN_SUB:
                    continue
            prev = {"start": round(s, 3), "end": round(e, 3), "text": text.strip(), "track": tid}
            out.append(prev)
    return sorted(out, key=lambda x: (x["start"], x["end"]))


def _visible_subtitle(project: dict, sub: dict) -> str | None:
    """자막이 속한 트랙 id. 숨긴 트랙이면 None."""
    tid = layers_mod.subtitle_track(project, sub)
    return None if layers_mod.track_map(project).get(tid, {}).get("hidden") else tid


def _free_subtitles(project: dict) -> list[tuple]:
    """조각에서 분리된 자막: 결과 시간(e_start~e_end)에 그대로 놓인다."""
    out = []
    for s in project["subtitles"]:
        tid = _visible_subtitle(project, s)
        if tid and s.get("free") and s.get("e_start") is not None and s.get("e_end") is not None:
            out.append((float(s["e_start"]), float(s["e_end"]), s["text"], tid))
    return out


def remap_subtitles(project: dict, cuts: list[tuple[float, float]],
                    speeds: list[tuple[float, float, float]] | None = None) -> list[dict]:
    raw = []
    for s in project["subtitles"]:
        tid = _visible_subtitle(project, s)
        if tid and not s.get("free"):
            raw.append((map_time(s["start"], cuts, speeds), map_time(s["end"], cuts, speeds), s["text"], tid))
    return _finish_subtitles(raw + _free_subtitles(project))


def output_subtitles(project: dict) -> list[dict]:
    """결과 영상 기준 자막. 배치(순서 바꿈·빈칸)가 있으면 조각 위치를 따라가고, 없으면 컷만 반영한다."""
    speeds = merged_speeds(project)
    items = layout_mod.items_of(project)
    extra = layers_mod.carried_atoms(project)
    if items is None and not extra:
        return remap_subtitles(project, merged_cuts(project), speeds)
    placed, _ = layout_mod.place(items if items is not None else layout_mod.default_items(project), speeds)
    raw = []
    for s in project["subtitles"]:
        tid = _visible_subtitle(project, s)
        if tid and not s.get("free"):
            raw += [(a, b, text, tid) for a, b, text in layout_mod.instances(placed, [s], extra)]
    return _finish_subtitles(raw + _free_subtitles(project))


def layout_sequence(project: dict) -> list[tuple] | None:
    """배치가 기본이 아니면 렌더링 순서(빈칸·조각)를 만든다. 기본이면 None(기존 방식 사용)."""
    items = layout_mod.items_of(project)
    if items is None:
        return None
    fps = project["output"]["fps"]
    placed, _ = layout_mod.place(items, merged_speeds(project))
    clips = [(c, _grid(c["offset"], fps)) for c in project["clips"]]
    seq: list[tuple] = []
    cursor = 0
    for it in placed:
        for at in it.atoms:
            if at.f0 > cursor:
                seq.append(("gap", at.f0 - cursor))
            mid = (at.a + at.b) / 2
            clip, c0 = next(((c, o) for c, o in clips if o - 1e-6 <= mid < o + c["duration"] + 1e-6), clips[-1])
            s = max(0.0, at.a - c0)
            e = min(clip["duration"], at.b - c0)
            seq.append(("atom", clip, round(s, 6), round(e, 6), at.speed, at.f1 - at.f0))
            cursor = at.f1
    return seq


# ---------- 자막 파일 ----------

def _srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def to_srt(subs: list[dict]) -> str:
    blocks = [f"{i}\n{_srt_time(s['start'])} --> {_srt_time(s['end'])}\n{s['text']}\n"
              for i, s in enumerate(subs, 1)]
    return "\n".join(blocks)


def _ass_time(t: float) -> str:
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _ass_color(hex_rgb: str, alpha: int = 0) -> str:
    h = hex_rgb.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _ass_style_line(name: str, style: dict, width: int, height: int) -> str:
    size = height * style["size"] / 100  # 미리보기와 같은 글자 크기(px)
    outline = size * style["outline"]
    shadow = size * 0.05 if style["shadow"] else 0
    font_size = size * FONT_CELL_RATIO
    align = 8 if style["position"] == "top" else 2  # 8: 상단 가운데, 2: 하단 가운데
    margin_v = height * style["margin"] / 100
    return (f"Style: {name},{style['font']},{font_size:.1f},{_ass_color(style['color'])},{_ass_color(style['color'])},"
            f"{_ass_color(style['outline_color'])},{_ass_color('#000000', 0x60)},0,0,0,0,100,100,0,0,1,"
            f"{outline:.2f},{shadow:.2f},{align},{int(width * 0.05)},{int(width * 0.05)},{int(margin_v)},1")


_ASS_HEAD = ("[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\n"
             "PlayResX: {w}\nPlayResY: {h}\n\n[V4+ Styles]\n"
             "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
             "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
             "Alignment, MarginL, MarginR, MarginV, Encoding\n")
_ASS_EVENTS = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"


def _ass_text(text: str) -> str:
    return text.replace("\\", "＼").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def to_ass(subs: list[dict], style: dict, width: int, height: int) -> str:
    """영상에 입힐 자막(ASS). 크기·여백은 편집 화면 미리보기와 같은 '영상 높이 대비 %' 기준."""
    lines = [f"Dialogue: 0,{_ass_time(s['start'])},{_ass_time(s['end'])},Default,,0,0,0,,{_ass_text(s['text'])}"
             for s in subs]
    return (_ASS_HEAD.format(w=width, h=height) + _ass_style_line("Default", style, width, height) + "\n\n"
            + _ASS_EVENTS + "\n".join(lines) + "\n")


def to_ass_layers(subs: list[dict], styles: dict[str, dict], layers: dict[str, int], width: int, height: int) -> str:
    """자막 레이어(트랙)마다 스타일을 따로 두고, 위 레이어가 앞에 그려지게 Layer 번호를 준다."""
    used = sorted({s.get("track", "") for s in subs})
    head = _ASS_HEAD.format(w=width, h=height) + "\n".join(
        _ass_style_line(f"T_{tid}", styles[tid], width, height) for tid in used) + "\n\n"
    lines = [f"Dialogue: {layers.get(s.get('track', ''), 1)},{_ass_time(s['start'])},{_ass_time(s['end'])},"
             f"T_{s.get('track', '')},,0,0,0,,{_ass_text(s['text'])}" for s in subs]
    return head + _ASS_EVENTS + "\n".join(lines) + "\n"


# ---------- 실행 ----------

def _unique(base: Path) -> Path:
    if not base.exists():
        return base
    for i in range(2, 1000):
        cand = base.with_name(f"{base.stem} ({i}){base.suffix}")
        if not cand.exists():
            return cand
    raise RuntimeError("출력 파일 이름을 정할 수 없습니다.")


def _safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip() or "영상"


def encode(project: dict, mp4: Path, burn: bool, progress=None) -> float:
    """컷을 반영한 mp4 하나를 만든다(burn=True면 자막을 영상에 입힘). 결과 길이(초)를 돌려준다.

    가능하면 인텔 하드웨어 가속(h264_qsv)으로 인코딩한다. 실패하면(드문 경우, 예: 해상도 제한이나
    드라이버 문제) CPU 인코더(libx264)로 자동 재시도하고, 이후 인코딩도 CPU로 전환한다.
    """
    cuts = merged_cuts(project)
    speeds = merged_speeds(project)
    sequence = layout_sequence(project)
    segments = keep_pieces(project, cuts, speeds) if speeds else keep_segments(project, cuts)
    subs = output_subtitles(project)
    w, h = project["output"]["width"], project["output"]["height"]
    plan = layers_mod.build_plan(project)
    files = {}
    vf = ""
    if burn and subs:
        tracks = {s["track"] for s in subs}
        styles = {tid: layers_mod.subtitle_style(project, tid, project["style"]) for tid in tracks}
        order = {tid: layers_mod.subtitle_layer(project, tid) for tid in tracks}
        files["subs.ass"] = to_ass_layers(subs, styles, order, w, h)
        vf = "ass=subs.ass"
    if sequence:
        inputs, graph, total = render.build_layout_graph(project, sequence, render.even(w), render.even(h), vf, plan)
    else:
        inputs, graph, total = render.build_inputs_and_graph(project, segments, render.even(w), render.even(h), vf, plan)
    common = ["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    used_qsv = render.qsv_available()
    try:
        render.run_ffmpeg(inputs, graph, [*render.video_encode_args(), *common], mp4, total, progress, files=files)
    except MediaError:
        if not used_qsv:
            raise
        render.disable_qsv()  # 하드웨어 인코딩이 실패했으니 이후에는 CPU로만 시도
        render.run_ffmpeg(inputs, graph, [*render.video_encode_args(), *common], mp4, total, progress, files=files)
    return total


def write_srt(project: dict, path: Path) -> int:
    subs = output_subtitles(project)
    path.write_text(to_srt(subs), encoding="utf-8-sig")  # BOM: 윈도우 프로그램 한글 깨짐 방지
    return len(subs)


# ---------- 형식별 결과물 묶음 (내보내기 · 완료 공용) ----------

FORMATS = {
    "burned": "완성 영상 (자막 입힘)",
    "clean": "자막 없는 영상 + SRT (유튜브 자막 업로드·캡컷용)",
    "premiere": "프리미어/다빈치용 XML + 원본 클립 + SRT",
}


def package_dir(out_dir: Path, name: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    return _unique(out_dir / f"{_safe(name)}_{stamp}")


def encode_formats(project: dict, pkg: Path, formats: list[str], progress=None) -> list[str]:
    """완료용 인코딩(영상이 필요한 형식만)과 SRT. 원본 클립 이동·XML은 호출하는 쪽(jobs)에서 한다.

    만든 파일 경로 목록을 돌려준다.
    """
    pkg.mkdir(parents=True, exist_ok=True)
    base = _safe(project.get("name", "영상"))
    made: list[str] = []
    jobs = [f for f in ("burned", "clean") if f in formats]
    for i, fmt in enumerate(jobs):
        mp4 = pkg / (f"{base}_자막입힘.mp4" if fmt == "burned" else f"{base}.mp4")
        cb = (lambda f, i=i: progress((i + f) / len(jobs))) if progress else None
        encode(project, mp4, burn=(fmt == "burned"), progress=cb)
        made.append(str(mp4))
    if "clean" in formats or "premiere" in formats:
        srt = pkg / f"{base}.srt"
        write_srt(project, srt)
        made.append(str(srt))
    return made


def prepare_media(project: dict, media_dir: Path, move: bool) -> dict[str, Path]:
    """XML이 가리킬 클립 파일을 media_dir에 마련한다.

    move=True(완료): 업로드 사본을 그대로 옮긴다 — 작업 기록을 지울 것이므로 사본이 필요 없어진다.
    move=False(내보내기, 작업 유지): 복사한다 — 원본 편집 프로젝트가 계속 그 파일을 써야 한다.
    move 중 실패하면 옮긴 파일을 되돌린다.
    """
    media_dir.mkdir(parents=True, exist_ok=True)
    used: set[str] = set()
    moved: list[tuple[Path, Path]] = []
    result: dict[str, Path] = {}
    try:
        for clip in project["clips"]:
            src = Path(clip["path"])
            name = re.sub(r'[\\/:*?"<>|]', "_", Path(clip["name"]).name) or "video.mp4"
            stem, suf = Path(name).stem, Path(name).suffix
            k = 2
            while name.lower() in used:
                name = f"{stem} ({k}){suf}"
                k += 1
            used.add(name.lower())
            dst = media_dir / name
            if move:
                shutil.move(str(src), str(dst))
                moved.append((dst, src))
            else:
                shutil.copy2(str(src), str(dst))
            result[clip["id"]] = dst
            result["clip:" + clip["id"]] = dst
        plan = layers_mod.build_plan(project)  # 다른 레이어에 올린 자료도 XML이 가리킬 수 있게 함께 둔다
        assets = {a["id"]: a for a in project.get("assets", [])}
        for aid in sorted({li.src for li in plan.visuals + plan.audios if li.type != "clip"}):
            a = assets.get(aid)
            if not a:
                continue
            src = Path(a["path"])
            name = re.sub(r'[\/:*?"<>|]', "_", a["name"]) or "asset"
            stem, suf = Path(name).stem, Path(name).suffix
            k = 2
            while name.lower() in used:
                name = f"{stem} ({k}){suf}"
                k += 1
            used.add(name.lower())
            dst = media_dir / name
            if move:
                shutil.move(str(src), str(dst))
                moved.append((dst, src))
            else:
                shutil.copy2(str(src), str(dst))
            result["asset:" + aid] = dst
    except Exception:
        for dst, src in reversed(moved):
            shutil.move(str(dst), str(src))
        raise
    return result


def write_xml(project: dict, pkg: Path, media: dict[str, Path]) -> Path:
    cuts = merged_cuts(project)
    speeds = merged_speeds(project)
    plan = layers_mod.build_plan(project)
    xml = pkg / f"{_safe(project.get('name', '영상'))}_프리미어_다빈치.xml"
    xml.write_text(nle.to_xml(project, keep_pieces(project, cuts, speeds), media, project.get("name", "영상"),
                           sequence=layout_sequence(project), layers=plan.visuals + [a for a in plan.audios if a.type == "audio"]),
                   encoding="utf-8")
    return xml


def build_package(project: dict, out_dir: Path, formats: list[str], move_media: bool, progress=None) -> dict:
    """형식별 결과물 묶음을 만든다. 내보내기(move_media=False)와 완료(move_media=True)가 함께 쓴다."""
    pkg = package_dir(out_dir, project.get("name", "영상"))
    files = encode_formats(project, pkg, formats, progress)
    if "premiere" in formats:
        media = prepare_media(project, pkg / "media", move=move_media)
        xml = write_xml(project, pkg, media)
        files.append(str(xml))
        files += [str(p) for p in dict.fromkeys(media.values())]
    return {"folder": str(pkg), "files": files, "formats": formats,
            "created": datetime.now().isoformat(timespec="seconds")}
