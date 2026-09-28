"""내보내기 검증: 컷 합치기, 남길 구간, 자막 시간 변환, 실제 인코딩 결과의 길이·프레임 수."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from backend.core import export, media, project, render, silence
from tests.test_silence import make_clip


def fake_project(cuts, subs=(), clips=((0.0, 10.0), (10.0, 5.0))):
    return {
        "duration": sum(d for _, d in clips),
        "output": {"width": 320, "height": 180, "fps": 30},
        "clips": [{"id": f"c{i + 1}", "offset": o, "duration": d} for i, (o, d) in enumerate(clips)],
        "cuts": [{"start": s, "end": e, "enabled": en} for s, e, en in cuts],
        "subtitles": [{"start": s, "end": e, "text": t} for s, e, t in subs],
    }


class MathTest(unittest.TestCase):
    def test_merge_overlapping_and_skip_disabled(self):
        p = fake_project([(1.0, 2.0, True), (1.5, 3.0, True), (5.0, 6.0, False), (7.01, 7.5, True)])
        self.assertEqual(export.merged_cuts(p), [(1.0, 3.0), (7.0, 7.5)])  # 7.01 → 프레임 격자 7.0

    def test_keep_segments_split_by_clip(self):
        p = fake_project([(9.0, 11.0, True)])  # 클립 경계(10초)를 넘는 컷
        segs = export.keep_segments(p, export.merged_cuts(p))
        self.assertEqual(segs, {"c1": [(0.0, 9.0)], "c2": [(1.0, 5.0)]})

    def test_map_time(self):
        cuts = [(1.0, 3.0), (5.0, 6.0)]
        self.assertAlmostEqual(export.map_time(0.5, cuts), 0.5)
        self.assertAlmostEqual(export.map_time(2.0, cuts), 1.0)  # 컷 안 → 컷 시작 자리
        self.assertAlmostEqual(export.map_time(4.0, cuts), 2.0)
        self.assertAlmostEqual(export.map_time(7.0, cuts), 4.0)

    def test_remap_subtitles(self):
        p = fake_project([(1.0, 3.0, True)], subs=[
            (0.0, 1.5, "컷에 걸침"),     # → 0~1
            (1.2, 2.8, "컷 안에 있음"),   # → 빠짐
            (3.0, 4.0, "뒤로 밀림"),      # → 1~2
        ])
        out = export.remap_subtitles(p, export.merged_cuts(p))
        self.assertEqual([(s["start"], s["end"], s["text"]) for s in out],
                         [(0.0, 1.0, "컷에 걸침"), (1.0, 2.0, "뒤로 밀림")])

    def test_srt_format(self):
        srt = export.to_srt([{"start": 61.5, "end": 3723.004, "text": "안녕"}])
        self.assertEqual(srt, "1\n00:01:01,500 --> 01:02:03,004\n안녕\n")


class EncodeTest(unittest.TestCase):
    """합성 영상 2개(10초씩)를 실제로 인코딩해 길이·프레임 수·자막 파일을 확인한다."""

    def test_export_end_to_end(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            a, b = td / "a.mp4", td / "b.mp4"
            make_clip(a)
            make_clip(b)
            before = (a.stat().st_size, a.stat().st_mtime_ns)
            p = project.build_project([a, b], silence.SilenceParams())
            p["name"] = "테스트"
            p["cuts"] = [{"start": 3.0, "end": 4.5, "enabled": True},
                         {"start": 9.5, "end": 11.0, "enabled": True},   # 클립 경계를 넘는 컷
                         {"start": 15.0, "end": 16.0, "enabled": False}]  # 꺼진 제안은 무시
            p["subtitles"] = [{"start": 1.0, "end": 2.0, "text": "첫 자막"},
                              {"start": 12.0, "end": 13.0, "text": "둘째 자막"}]
            r = export.build_package(p, td / "out", ["burned", "clean"], move_media=False)

            expected = 20.0 - 1.5 - 1.5
            mp4 = next(f for f in r["files"] if f.endswith("_자막입힘.mp4"))
            info = json.loads(subprocess.run(
                [media.ffprobe(), "-v", "error", "-count_frames", "-show_entries",
                 "stream=codec_type,nb_read_frames,duration", "-of", "json", mp4],
                capture_output=True, check=True).stdout)
            v = next(s for s in info["streams"] if s["codec_type"] == "video")
            a_ = next(s for s in info["streams"] if s["codec_type"] == "audio")
            self.assertEqual(int(v["nb_read_frames"]), round(expected * 30))
            self.assertAlmostEqual(float(a_["duration"]), expected, delta=0.03)

            srt_path = next(f for f in r["files"] if f.endswith(".srt"))
            srt = Path(srt_path).read_text(encoding="utf-8-sig")
            # 둘째 자막: 12초 - 앞에서 잘린 3초 = 9초
            self.assertIn("00:00:09,000 --> 00:00:10,000\n둘째 자막", srt)
            self.assertEqual(before, (a.stat().st_size, a.stat().st_mtime_ns))  # 원본 그대로

            # 같은 이름으로 다시 내보내도 기존 폴더를 덮어쓰지 않는다
            r2 = export.build_package(p, td / "out", ["clean"], move_media=False)
            self.assertNotEqual(r["folder"], r2["folder"])
            self.assertTrue(Path(mp4).is_file())

    def test_premiere_format_copies_not_moves_when_project_kept(self):
        """내보내기(작업 유지)에서 프리미어 형식을 고르면 원본 클립은 복사되고, 원본은 그대로 남는다."""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            a = td / "a.mp4"
            make_clip(a)
            before = (a.stat().st_size, a.stat().st_mtime_ns)
            p = project.build_project([a], silence.SilenceParams())
            p["name"] = "테스트2"
            p["cuts"] = []
            p["subtitles"] = [{"start": 1.0, "end": 2.0, "text": "자막"}]

            r = export.build_package(p, td / "out", ["premiere"], move_media=False)
            self.assertTrue(a.is_file())  # 원본 클립이 옮겨지지 않았다
            self.assertEqual(before, (a.stat().st_size, a.stat().st_mtime_ns))
            media_files = [f for f in r["files"] if Path(f).parent.name == "media"]
            self.assertEqual(len(media_files), 1)
            self.assertTrue(Path(media_files[0]).is_file())  # 복사본도 존재
            self.assertTrue(any(f.endswith(".xml") for f in r["files"]))
            self.assertTrue(any(f.endswith(".srt") for f in r["files"]))

    def test_premiere_format_moves_when_finalizing(self):
        """완료(move_media=True)에서는 원본 클립이 결과 폴더로 옮겨진다."""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            a = td / "a.mp4"
            make_clip(a)
            p = project.build_project([a], silence.SilenceParams())
            p["name"] = "테스트3"
            p["cuts"] = []
            p["subtitles"] = []

            r = export.build_package(p, td / "out", ["premiere"], move_media=True)
            self.assertFalse(a.exists())  # 원본 자리에서 사라짐(옮겨짐)
            media_files = [f for f in r["files"] if Path(f).parent.name == "media"]
            self.assertEqual(len(media_files), 1)
            self.assertTrue(Path(media_files[0]).is_file())


class EncoderSelectionTest(unittest.TestCase):
    """하드웨어 인코더(h264_qsv) 자동 감지·대체 로직. 실제 인코딩은 모킹해 가볍게 검사한다."""

    def setUp(self):
        self._saved = render._qsv_available

    def tearDown(self):
        render._qsv_available = self._saved

    def test_video_encode_args_reflects_availability(self):
        render._qsv_available = True
        self.assertIn("h264_qsv", render.video_encode_args())
        render._qsv_available = False
        self.assertIn("libx264", render.video_encode_args())

    def test_encode_falls_back_to_cpu_when_qsv_fails(self):
        """하드웨어 인코딩이 실패하면(드라이버 문제 등) 자동으로 CPU 인코더로 한 번 더 시도한다."""
        render._qsv_available = True
        calls: list[list[str]] = []

        def fake_run_ffmpeg(inputs, graph, output_args, mp4, total, progress=None, files=None):
            calls.append(output_args)
            if "h264_qsv" in output_args:
                raise media.MediaError("가짜 하드웨어 인코딩 실패")
            Path(mp4).write_bytes(b"fake")  # 인코딩된 것처럼 결과 파일만 만들어 둔다

        with tempfile.TemporaryDirectory() as td:
            a = Path(td) / "a.mp4"
            make_clip(a)
            proj = project.build_project([a], silence.SilenceParams())
            proj["subtitles"] = []
            proj["cuts"] = []
            orig = render.run_ffmpeg
            render.run_ffmpeg = fake_run_ffmpeg
            try:
                total = export.encode(proj, Path(td) / "out.mp4", burn=False)
            finally:
                render.run_ffmpeg = orig
            self.assertTrue((Path(td) / "out.mp4").is_file())  # 재시도로 결과 파일이 만들어짐

        self.assertEqual(len(calls), 2)  # 실패 1번(QSV) + 성공 1번(CPU 재시도)
        self.assertIn("h264_qsv", calls[0])
        self.assertIn("libx264", calls[1])
        self.assertFalse(render._qsv_available)  # 실패했으니 이후로는 CPU만 쓰도록 꺼짐
        self.assertGreater(total, 0)

    def test_encode_does_not_retry_when_cpu_fails(self):
        """CPU 인코더 자체가 실패하면(대체 대상이 없으므로) 그대로 오류를 낸다."""
        render._qsv_available = False

        def always_fail(inputs, graph, output_args, mp4, total, progress=None, files=None):
            raise media.MediaError("가짜 인코딩 실패")

        with tempfile.TemporaryDirectory() as td:
            a = Path(td) / "a.mp4"
            make_clip(a)
            proj = project.build_project([a], silence.SilenceParams())
            proj["subtitles"] = []
            proj["cuts"] = []
            orig = render.run_ffmpeg
            render.run_ffmpeg = always_fail
            try:
                with self.assertRaises(media.MediaError):
                    export.encode(proj, Path(td) / "out.mp4", burn=False)
            finally:
                render.run_ffmpeg = orig


if __name__ == "__main__":
    unittest.main()
