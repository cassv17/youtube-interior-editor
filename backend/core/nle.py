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


def to_xml(project: dict, segments: dict[str, list[tuple]], media: dict[str, Path],
           name: str, sequence: list[tuple] | None = None) -> str:
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
        f"<track>{video}</track></video>"
        f"<audio><numOutputChannels>2</numOutputChannels>{audio_tracks}</audio>"
        "</media></sequence></xmeml>\n"
    )
