"""프리미어 프로 / 다빈치 리졸브에서 이어서 편집할 수 있는 Final Cut Pro 7 XML(xmeml)을 만든다.

- 컷을 반영한 '남길 구간'마다 클립 조각(clipitem)을 하나씩 놓는다 → 프로그램에서 조각별로 다시 조정 가능.
- 영상 트랙 1개 + 음성 트랙 2개(스테레오 좌/우). FCP7 XML의 일반적인 스테레오 표기 방식이다.
- 자막은 XML에 넣지 않고 같은 폴더의 SRT로 제공한다(프리미어: 파일 > 가져오기로 SRT → 캡션 트랙).
- 배속 구간은 조각마다 'Time Remap'(speed 값, 100=원래 속도) 효과를 붙인다. 조각의 시퀀스 길이는 (길이 ÷ 배속)이다.
- 미디어 경로는 절대 경로(file://localhost/C:/...)로 적는다. 폴더를 옮기면 프로그램이 '미디어 다시 연결'을 묻는다.
"""
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

SEQ_FPS = 30


def _rate(fps: float) -> str:
    # 29.97 같은 NTSC 계열은 timebase 30 + ntsc TRUE로 표기한다
    ntsc = abs(fps - round(fps)) > 0.01
    return f"<rate><timebase>{round(fps)}</timebase><ntsc>{'TRUE' if ntsc else 'FALSE'}</ntsc></rate>"


def _pathurl(p: Path) -> str:
    return "file://localhost/" + quote(p.resolve().as_posix(), safe="/:")


def _speed_filter(speed: float, mediatype: str) -> str:
    def param(pid: str, value: str, extra: str = "") -> str:
        return (f'<parameter authoringApp="PremierePro"><parameterid>{pid}</parameterid><name>{pid}</name>'
                f"{extra}<value>{value}</value></parameter>")

    return (
        "<filter><effect><name>Time Remap</name><effectid>timeremap</effectid>"
        f"<effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>{mediatype}</mediatype>"
        + param("variablespeed", "0", "<valuemin>0</valuemin><valuemax>1</valuemax>")
        + param("speed", f"{speed * 100:g}", "<valuemin>-100000</valuemin><valuemax>100000</valuemax>")
        + param("reverse", "FALSE")
        + param("frameblending", "FALSE")
        + "</effect></filter>"
    )


def _filter(name: str, effectid: str, category: str, mediatype: str, params: str) -> str:
    return (f"<filter><effect><name>{name}</name><effectid>{effectid}</effectid>"
            f"<effectcategory>{category}</effectcategory><effecttype>{category}</effecttype>"
            f"<mediatype>{mediatype}</mediatype>{params}</effect></filter>")


def _param(pid: str, label: str, value: str, lo: str = "", hi: str = "") -> str:
    rng = (f"<valuemin>{lo}</valuemin><valuemax>{hi}</valuemax>" if lo != "" else "")
    return f'<parameter authoringApp="PremierePro"><parameterid>{pid}</parameterid><name>{label}</name>{rng}<value>{value}</value></parameter>'


def _layer_tracks(layers: list, media: dict, w: int, h: int, written: set[str], tracks: list) -> tuple[str, str]:
    """추가 레이어를 트랙별 XML로. layers: 합성 항목(LayerItem) 목록(아래 → 위), tracks: 트랙 정보(보이는 트랙만).
    미디어 파일은 media['clip:<id>'] 또는 media['asset:<id>'] 의 복사본을 가리킨다."""
    vids: dict[str, list] = {}
    auds: dict[str, list] = {}
    for li in layers:
        if li.type in ("video", "image", "clip"):
            vids.setdefault(li.track, []).append(li)
        if li.has_audio and (li.type == "audio" or li.type in ("video", "clip")):
            auds.setdefault(li.track, []).append(li)

    def file_el(li) -> str:
        key = ("clip:" if li.type == "clip" else "asset:") + li.src
        fid = f"file-{key}"
        if fid in written:
            return f'<file id="{escape(fid)}"/>'
        written.add(fid)
        path = media[key]
        dur = round(li.src_dur * 30) if li.type != "image" else 150
        video = (f"<video><samplecharacteristics><width>{li.src_w or w}</width><height>{li.src_h or h}</height>"
                 "</samplecharacteristics></video>") if li.type != "audio" else ""
        audio = ("<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics>"
                 "<channelcount>2</channelcount></audio>") if li.has_audio else ""
        return (f'<file id="{escape(fid)}"><name>{escape(path.name)}</name><pathurl>{escape(_pathurl(path))}</pathurl>'
                f"{_rate(30)}<duration>{dur}</duration><media>{video}{audio}</media></file>")

    def common(li, idx: int, kind: str) -> str:
        start, end = li.start_f, li.start_f + li.frames
        a = round(li.src_in * 30)
        return (f'<clipitem id="{kind}-{escape(li.id)}-{idx}"><name>{escape(li.name or li.id)}</name><enabled>TRUE</enabled>'
                f"<duration>{max(li.frames, round(li.src_dur * 30))}</duration>{_rate(30)}"
                f"<start>{start}</start><end>{end}</end><in>{a}</in><out>{a + li.frames}</out>{file_el(li)}")

    video_xml = ""
    for tid, items in vids.items():
        body = ""
        for i, li in enumerate(items):
            fit = min(w / max(li.src_w, 1), h / max(li.src_h, 1)) if li.src_w and li.src_h else 1.0
            motion = _filter("Basic Motion", "basic", "motion", "video",
                             _param("scale", "Scale", f"{li.scale * fit * 100:.2f}", "0", "1000")
                             + _param("center", "Center", f"<horiz>{li.x - 0.5:.4f}</horiz><vert>{li.y - 0.5:.4f}</vert>"))
            opac = _filter("Opacity", "opacity", "motion", "video",
                           _param("opacity", "opacity", f"{li.opacity * 100:.1f}", "0", "100")) if li.opacity < 0.999 else ""
            body += common(li, i, "v") + motion + opac + "</clipitem>"
        video_xml += f"<track>{body}</track>"

    audio_xml = ""
    for tid, items in auds.items():
        for ch in (1, 2):
            body = ""
            for i, li in enumerate(items):
                lvl = _filter("Audio Levels", "audiolevels", "audiolevels", "audio",
                              _param("level", "Level", f"{li.volume:.3f}", "0", "3.98109")) if abs(li.volume - 1) > 1e-6 else ""
                body += (common(li, i, "a") + lvl
                         + f"<sourcetrack><mediatype>audio</mediatype><trackindex>{ch}</trackindex></sourcetrack></clipitem>")
            audio_xml += f"<track>{body}</track>"
    return video_xml, audio_xml


def to_xml(project: dict, segments: dict[str, list[tuple]], media: dict[str, Path],
           name: str, sequence: list[tuple] | None = None, layers: list | None = None) -> str:
    """segments: {clip_id: [(클립 기준 시작, 끝) 또는 (시작, 끝, 배속)]}, media: {clip_id: 미디어 파일 경로}

    sequence가 있으면(결과 배치: 순서 바꿈·빈칸) segments 대신 그 순서와 위치를 그대로 쓴다.
    항목: ("gap", 프레임수) 또는 ("atom", 클립, 클립 기준 시작, 끝, 배속, 결과 프레임수)
    """
    w, h = project["output"]["width"], project["output"]["height"]
    items = []  # (clip, seg_start, seg_end, seq_in, seq_out, speed)
    pos = 0
    if sequence is not None:
        for entry in sequence:
            if entry[0] == "gap":
                pos += int(entry[1])
                continue
            _, clip, s, e, speed, n = entry
            items.append((clip, s, e, pos, pos + int(n), speed))
            pos += int(n)
    else:
        for clip in project["clips"]:
            for seg in segments.get(clip["id"], []):
                s, e = seg[0], seg[1]
                speed = seg[2] if len(seg) > 2 else 1.0
                n = round((e - s) / speed * SEQ_FPS)
                if n <= 0:
                    continue
                items.append((clip, s, e, pos, pos + n, speed))
                pos += n
    total = pos

    files_written: set[str] = set()

    def file_el(clip) -> str:
        fid = f"file-{clip['id']}"
        if fid in files_written:
            return f'<file id="{fid}"/>'
        files_written.add(fid)
        fps = clip.get("fps") or SEQ_FPS
        dur = round(clip.get("source_duration", clip["duration"]) * fps)
        return (
            f'<file id="{fid}"><name>{escape(media[clip["id"]].name)}</name>'
            f"<pathurl>{escape(_pathurl(media[clip['id']]))}</pathurl>{_rate(fps)}<duration>{dur}</duration>"
            f"<media><video><samplecharacteristics><width>{clip['width']}</width><height>{clip['height']}</height>"
            f"</samplecharacteristics></video>"
            f"<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics>"
            f"<channelcount>2</channelcount></audio></media></file>"
        )

    def clipitem(kind: str, idx: int, clip, s, e, a, b, speed: float, track_index: int = 1) -> str:
        fps = clip.get("fps") or SEQ_FPS
        cid = f"{kind}-{idx + 1}" + (f"-{track_index}" if kind == "a" else "")
        src_in, src_out = round(s * fps), round(e * fps)
        links = "".join(
            f"<link><linkclipref>{ref}</linkclipref><mediatype>{mt}</mediatype><trackindex>{ti}</trackindex>"
            f"<clipindex>{idx + 1}</clipindex></link>"
            for ref, mt, ti in ((f"v-{idx + 1}", "video", 1), (f"a-{idx + 1}-1", "audio", 1),
                                (f"a-{idx + 1}-2", "audio", 2))
        )
        src = (f"<sourcetrack><mediatype>audio</mediatype><trackindex>{track_index}</trackindex></sourcetrack>"
               if kind == "a" else "")
        return (
            f'<clipitem id="{cid}"><name>{escape(clip["name"])}</name><enabled>TRUE</enabled>'
            f"<duration>{round(clip.get('source_duration', clip['duration']) * fps)}</duration>{_rate(fps)}"
            f"<start>{a}</start><end>{b}</end><in>{src_in}</in><out>{src_out}</out>"
            f"{file_el(clip)}"
            f"{_speed_filter(speed, 'audio' if kind == 'a' else 'video') if abs(speed - 1.0) > 1e-6 else ''}"
            f"{src}{links}</clipitem>"
        )

    extra_v, extra_a = _layer_tracks(layers or [], media, w, h, files_written, []) if layers else ("", "")
    total = max(total, max([li.start_f + li.frames for li in layers] or [0])) if layers else total
    video = "".join(clipitem("v", i, c, s, e, a, b, sp) for i, (c, s, e, a, b, sp) in enumerate(items))
    audio_tracks = "".join(
        "<track>" + "".join(clipitem("a", i, c, s, e, a, b, sp, ti) for i, (c, s, e, a, b, sp) in enumerate(items))
        + "</track>"
        for ti in (1, 2)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">'
        f'<sequence id="sequence-1"><name>{escape(name)}</name><duration>{total}</duration>{_rate(SEQ_FPS)}'
        "<timecode><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat>"
        f"{_rate(SEQ_FPS)}</timecode>"
        "<media><video><format><samplecharacteristics>"
        f"{_rate(SEQ_FPS)}<width>{w}</width><height>{h}</height><pixelaspectratio>square</pixelaspectratio>"
        "</samplecharacteristics></format>"
        f"<track>{video}</track>{extra_v}</video>"
        f"<audio><numOutputChannels>2</numOutputChannels>{audio_tracks}{extra_a}</audio>"
        "</media></sequence></xmeml>\n"
    )
