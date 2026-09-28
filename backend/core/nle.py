"""프리미어 프로 / 다빈치 리졸브에서 이어서 편집할 수 있는 Final Cut Pro 7 XML(xmeml)을 만든다.

- 컷을 반영한 '남길 구간'마다 클립 조각(clipitem)을 하나씩 놓는다 → 프로그램에서 조각별로 다시 조정 가능.
- 영상 트랙 1개 + 음성 트랙 2개(스테레오 좌/우). FCP7 XML의 일반적인 스테레오 표기 방식이다.
- 자막은 XML에 넣지 않고 같은 폴더의 SRT로 제공한다(프리미어: 파일 > 가져오기로 SRT → 캡션 트랙).
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


def to_xml(project: dict, segments: dict[str, list[tuple[float, float]]], media: dict[str, Path],
           name: str) -> str:
    """segments: {clip_id: [(클립 기준 시작, 끝)]}, media: {clip_id: 미디어 파일 경로}"""
    w, h = project["output"]["width"], project["output"]["height"]
    items = []  # (clip, seg_start, seg_end, seq_in, seq_out)
    pos = 0
    for clip in project["clips"]:
        for s, e in segments.get(clip["id"], []):
            n = round((e - s) * SEQ_FPS)
            if n <= 0:
                continue
            items.append((clip, s, e, pos, pos + n))
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

    def clipitem(kind: str, idx: int, clip, s, e, a, b, track_index: int = 1) -> str:
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
            f"{file_el(clip)}{src}{links}</clipitem>"
        )

    video = "".join(clipitem("v", i, c, s, e, a, b) for i, (c, s, e, a, b) in enumerate(items))
    audio_tracks = "".join(
        "<track>" + "".join(clipitem("a", i, c, s, e, a, b, ti) for i, (c, s, e, a, b) in enumerate(items))
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
