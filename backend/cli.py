"""명령줄 도구 (웹 UI 없이 파이프라인을 확인할 때 사용).

예) python -m backend.cli analyze 예시파일 --out workspace/test/project.json
"""
import argparse
import sys
import time
from pathlib import Path

from .core import project, silence

VIDEO_EXT = {".mp4", ".mov", ".m4v"}


def _collect(inputs: list[str]) -> list[Path]:
    files = []
    for item in inputs:
        p = Path(item)
        if p.is_dir():
            files += sorted(f for f in p.iterdir() if f.suffix.lower() in VIDEO_EXT)
        else:
            files.append(p)
    return files


def _threshold(v: str):
    return v if v == "auto" else float(v)


def cmd_analyze(args) -> int:
    files = _collect(args.inputs)
    if not files:
        print("분석할 영상이 없습니다.", file=sys.stderr)
        return 1
    params = silence.SilenceParams(threshold=args.threshold, min_silence=args.min_silence,
                                   pad=args.pad)
    proj = project.build_project(
        files, params, progress=lambda i, n, name: print(f"[{i + 1}/{n}] 분석 중: {name}"))
    out = project.save(proj, args.out)

    print()
    for clip in proj["clips"]:
        st = proj["clip_analysis"][clip["id"]]
        n = sum(1 for c in proj["cuts"] if c["clip_id"] == clip["id"])
        flag = "  ⚠ " + st["note"] if st["note"] else ""
        print(f"{clip['id']} {clip['name']}  {clip['duration']:.1f}초  "
              f"소음 {st['noise_db']}dB / 말소리 {st['speech_db']}dB / 기준 {st['threshold_db']}dB  "
              f"컷 {n}개{flag}")
    s = project.summarize(proj)
    print(f"\n합계: 클립 {s['clips']}개, {s['duration']}초 → 컷 {s['cuts']}개 "
          f"({s['cut_seconds']}초 제거) → 결과 {s['result_seconds']}초, 확인 필요 {s['needs_review']}개")
    print(f"저장: {out}")
    return 0


def cmd_transcribe(args) -> int:
    from .core import stt  # faster-whisper가 필요할 때만 불러온다

    proj = project.load(args.project)
    params = stt.SubtitleParams(max_chars=args.max_chars)
    last = [-1]

    def progress(frac, name):
        pct = int(frac * 100)
        if pct // 10 != last[0]:
            last[0] = pct // 10
            print(f"  {pct:3d}%  {name}", flush=True)

    t0 = time.perf_counter()
    stats = stt.transcribe_project(proj, params, progress)
    elapsed = time.perf_counter() - t0
    project.save(proj, args.project)

    print()
    for s in proj["subtitles"]:
        mark = "  ⚠ " + " / ".join(s["review_reasons"]) if s["needs_review"] else ""
        print(f"{s['id']:>4} {s['start']:7.2f}~{s['end']:7.2f}  {s['text']}{mark}")
    print()
    for c in proj["cuts"]:
        state = "적용" if c["enabled"] else "제안(꺼짐)"
        why = "  ⚠ " + " / ".join(c["review_reasons"]) if c["needs_review"] else ""
        print(f"{c['id']:>7} {c['start']:7.2f}~{c['end']:7.2f} ({c['end'] - c['start']:.2f}s) {state}{why}")
    print(f"\n자막 {len(proj['subtitles'])}개 (확인 필요 {sum(s['needs_review'] for s in proj['subtitles'])}개)")
    print(f"컷 보정: 적용 컷 합계 {stats['before_seconds']}초 → {stats['after_seconds']}초 "
          f"(단어를 피해 조정 {stats['adjusted']}개), "
          f"제안 컷 {stats['proposed']}개 {stats['proposed_seconds']}초 (꺼진 상태)")
    print(f"인식 시간 {elapsed:.0f}초 / 영상 {proj['duration']:.0f}초 "
          f"(실시간 대비 {elapsed / proj['duration']:.2f}배)")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="backend.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("analyze", help="무음구간을 감지해 컷 JSON 생성")
    a.add_argument("inputs", nargs="+", help="영상 파일 또는 폴더 (폴더는 파일명 순서)")
    a.add_argument("--out", required=True, help="결과 project.json 경로")
    a.add_argument("--threshold", type=_threshold, default="auto", help="auto 또는 dB 숫자 (예: -35)")
    a.add_argument("--min-silence", type=float, default=0.6)
    a.add_argument("--pad", type=float, default=0.15)
    a.set_defaults(func=cmd_analyze)

    t = sub.add_parser("transcribe", help="로컬 음성인식으로 자막 생성 (project.json에 추가)")
    t.add_argument("project", help="analyze로 만든 project.json")
    t.add_argument("--max-chars", type=int, default=25, help="자막 한 줄 최대 글자 수")
    t.set_defaults(func=cmd_transcribe)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
