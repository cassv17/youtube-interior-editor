"""구간 배속 검증: 시간 계산, 인코딩 결과(프레임 수·음성 길이), 자막 시간, 순서 변경, 프리미어 XML."""
import json
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from backend import jobs
from backend.core import export, media, nle, project, render, silence
from tests.test_silence import make_clip
from tests.test_export import fake_project


def fake(cuts=(), speeds=(), subs=(), clips=((0.0, 10.0), (10.0, 5.0))):
    p = fake_project(list(cuts), list(subs), clips)
    p["speed_ranges"] = [{"id": f"r{i}", "start": s, "end": e, "speed": sp} for i, (s, e, sp) in enumerate(speeds)]
    return p


class SpeedMathTest(unittest.TestCase):
    def test_merged_speeds_cleans_ranges(self):
        p = fake(speeds=[(5.0, 8.0, 2.0), (7.0, 9.0, 1.5), (1.0, 2.0, 1.0), (3.0, 3.01, 2.0), (12.0, 14.0, 99)])
        out = export.merged_speeds(p)
        # 1배속·너무 짧은 구간은 빠지고, 겹친 구간은 앞 구간 끝에서 시작하고, 배속은 4배까지만
        self.assertEqual(out, [(5.0, 8.0, 2.0), (8.0, 9.0, 1.5), (12.0, 14.0, 4.0)])

    def test_map_time_without_speed_is_unchanged(self):
        cuts = [(1.0, 3.0), (5.0, 6.0)]
        for t in (0.5, 2.0, 4.0, 7.0):
            self.assertAlmostEqual(export.map_time(t, cuts, []), export.map_time(t, cuts))

    def test_map_time_with_speed_and_cuts(self):
        cuts = [(1.0, 3.0)]
        speeds = [(4.0, 8.0, 2.0)]
        m = lambda t: export.map_time(t, cuts, speeds)
        self.assertAlmostEqual(m(0.5), 0.5)
        self.assertAlmostEqual(m(2.0), 1.0)          # 컷 안 → 컷 시작 자리
        self.assertAlmostEqual(m(4.0), 2.0)          # 1~3 컷 2초 제거
        self.assertAlmostEqual(m(6.0), 3.0)          # 4~6 구간 2초를 2배속 → 1초
        self.assertAlmostEqual(m(10.0), 3.0 + 1.0 + 2.0)  # 6~8 → 1초, 8~10 → 2초

    def test_map_time_slow_motion(self):
        self.assertAlmostEqual(export.map_time(4.0, [], [(2.0, 4.0, 0.5)]), 2.0 + 4.0)

    def test_keep_pieces_split_at_speed_boundaries_in_clip_time(self):
        p = fake(cuts=[(9.0, 11.0, True)], speeds=[(8.0, 13.0, 2.0)])
        cuts = export.merged_cuts(p)
        pieces = export.keep_pieces(p, cuts, export.merged_speeds(p))
        # c1(0~10): 0~9 중 8~9가 2배속. c2(10~15): 11~15 → 클립 기준 1~5 중 1~3이 2배속
        self.assertEqual(pieces["c1"], [(0.0, 8.0, 1.0), (8.0, 9.0, 2.0)])
        self.assertEqual(pieces["c2"], [(1.0, 3.0, 2.0), (3.0, 5.0, 1.0)])

    def test_remap_subtitles_with_speed(self):
        p = fake(speeds=[(2.0, 6.0, 2.0)], subs=[(3.0, 5.0, "배속 안"), (7.0, 9.0, "배속 뒤")])
        out = export.remap_subtitles(p, [], export.merged_speeds(p))
        self.assertEqual([(s["start"], s["end"]) for s in out], [(2.5, 3.5), (5.0, 7.0)])

    def test_atempo_chain(self):
        self.assertEqual(render.atempo_chain(1.5), "atempo=1.500000")
        self.assertEqual(render.atempo_chain(4.0), "atempo=2.000000,atempo=2.000000")
        self.assertEqual(render.atempo_chain(0.5), "atempo=0.500000")


class SpeedProjectTest(unittest.TestCase):
    def test_reorder_moves_speed_ranges_with_clips(self):
        p = fake(speeds=[(2.0, 4.0, 2.0), (9.0, 12.0, 1.5)])
        out = project.reorder(p, ["c2", "c1"], [])
        spans = sorted((r["start"], r["end"], r["speed"]) for r in out["speed_ranges"])
        # c1(0~10)이 5~15로, c2(10~15)가 0~5로. 경계를 넘는 9~12는 c1 9~10 → 14~15, c2 10~12 → 0~2로 나뉨
        self.assertEqual(spans, [(0.0, 2.0, 1.5), (7.0, 9.0, 2.0), (14.0, 15.0, 1.5)])

    def test_reorder_moves_splits_with_clips_and_drops_clip_edges(self):
        p = fake()
        p["splits"] = [4.0, 10.0, 12.5]  # 10.0은 클립 경계라 버려진다
        out = project.reorder(p, ["c2", "c1"], [])
        self.assertEqual(out["splits"], [2.5, 9.0])  # c2(12.5 → 2.5), c1(4.0 → 9.0)

    def test_clean_splits_validation(self):
        self.assertEqual(jobs.clean_splits([3.0, 3.01, 0, 15, 99, "x", None, 7.5], 15.0), [3.0, 7.5])
        self.assertEqual(jobs.clean_splits("bad", 15.0), [])

    def test_clean_speeds_validation(self):
        out = jobs.clean_speeds([{"id": "a", "start": 5, "end": 9, "speed": 2},
                                 {"start": 8, "end": 12, "speed": 0.1},
                                 {"start": 1, "end": 1.05, "speed": 2},
                                 {"start": 2, "end": 3, "speed": 1}], 10.0)
        self.assertEqual(out, [{"id": "a", "start": 5.0, "end": 9.0, "speed": 2.0},
                               {"id": "speed-2", "start": 9.0, "end": 10.0, "speed": 0.5}])

    def test_xml_has_time_remap_and_shorter_sequence(self):
        p = fake(speeds=[(2.0, 6.0, 2.0)], clips=((0.0, 10.0),))
        p["clips"][0].update({"name": "a.mp4", "fps": 30, "width": 1920, "height": 1080})
        pieces = export.keep_pieces(p, [], export.merged_speeds(p))
        xml = nle.to_xml(p, pieces, {"c1": Path("C:/x/a.mp4")}, "t")
        root = ET.fromstring(xml.split("<!DOCTYPE xmeml>\n")[1])
        vitems = root.findall("./sequence/media/video/track/clipitem")
        self.assertEqual(len(vitems), 3)  # 0~2(1배) / 2~6(2배) / 6~10(1배)
        spans = [(int(c.find("start").text), int(c.find("end").text)) for c in vitems]
        self.assertEqual(spans, [(0, 60), (60, 120), (120, 240)])  # 2배속 조각은 4초가 2초(60프레임)
        speeds = [c.find("./filter/effect/parameter[parameterid='speed']/value") for c in vitems]
        self.assertEqual([s.text if s is not None else None for s in speeds], [None, "200", None])
        self.assertEqual(root.find("./sequence/duration").text, "240")
        a_items = root.findall("./sequence/media/audio/track/clipitem")
        self.assertEqual(sum(1 for c in a_items if c.find("filter") is not None), 2)  # 오디오 2트랙의 배속 조각


class SpeedEncodeTest(unittest.TestCase):
    """합성 영상을 실제로 인코딩해 프레임 수와 음성 길이가 계산과 맞는지 본다."""

    def _probe(self, mp4: str) -> tuple[int, float]:
        info = json.loads(subprocess.run(
            [media.ffprobe(), "-v", "error", "-count_frames", "-show_entries",
             "stream=codec_type,nb_read_frames,duration", "-of", "json", mp4],
            capture_output=True, check=True).stdout)
        v = next(s for s in info["streams"] if s["codec_type"] == "video")
        a = next(s for s in info["streams"] if s["codec_type"] == "audio")
        return int(v["nb_read_frames"]), float(a["duration"])

    def test_encode_with_speed_ranges_and_cuts(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            a, b = td / "a.mp4", td / "b.mp4"
            make_clip(a)
            make_clip(b)
            p = project.build_project([a, b], silence.SilenceParams())
            p["cuts"] = [{"start": 8.0, "end": 9.0, "enabled": True, "clip_id": "c1", "origin": "user",
                          "id": "x", "needs_review": False, "review_reasons": []}]
            p["subtitles"] = [{"start": 12.0, "end": 13.0, "text": "배속 구간 자막"}]
            # 2~6초 2배속, 12~14초 0.5배속(클립 경계 안), 9~11초는 클립 경계를 넘는 1.5배속
            p["speed_ranges"] = [{"id": "r1", "start": 2.0, "end": 6.0, "speed": 2.0},
                                 {"id": "r2", "start": 9.0, "end": 11.0, "speed": 1.5},
                                 {"id": "r3", "start": 12.0, "end": 14.0, "speed": 0.5}]
            mp4 = td / "out.mp4"
            total = export.encode(p, mp4, burn=False)

            # 20초 - 컷 1초 = 19초 중: 2배속 4초→2초, 1.5배속 9~11 중 컷(8~9) 밖이라 2초→1.333초, 0.5배속 2초→4초
            expected = (19.0 - 4.0 - 2.0 - 2.0) + 2.0 + 2.0 / 1.5 + 4.0
            frames, audio = self._probe(str(mp4))
            self.assertAlmostEqual(total, expected, delta=0.1)
            self.assertAlmostEqual(frames / 30, expected, delta=0.12)
            self.assertAlmostEqual(audio, expected, delta=0.12)
            self.assertAlmostEqual(frames / 30, audio, delta=0.07)  # 영상과 음성 길이가 서로 맞는다

            # 자막: 12초는 0.5배속 구간(12~14) 시작 → 결과 시간 = (12 - 컷 1초 - 앞 배속으로 줄어든 시간) 계산
            subs = export.remap_subtitles(p, export.merged_cuts(p), export.merged_speeds(p))
            start = export.map_time(12.0, export.merged_cuts(p), export.merged_speeds(p))
            self.assertAlmostEqual(subs[0]["start"], start, places=2)
            self.assertAlmostEqual(subs[0]["end"] - subs[0]["start"], 2.0, places=2)  # 1초가 0.5배속 → 2초

    def test_no_speed_keeps_frame_exact_path(self):
        """배속이 없으면 기존 경로 그대로여야 한다(프레임 수가 정확히 맞는 것이 기존 보장)."""
        p = fake()
        _, graph, _ = render.build_inputs_and_graph(
            {**p, "clips": [{**c, "path": "x.mp4", "has_audio": True} for c in p["clips"]]},
            {"c1": [(0.0, 5.0, 1.0)], "c2": [(0.0, 5.0)]}, 320, 180)
        self.assertNotIn("atempo", graph)
        self.assertNotIn("fps=30", graph.split("select")[1].split("[v0]")[0].replace("setpts=N/30/TB", ""))


if __name__ == "__main__":
    unittest.main()
