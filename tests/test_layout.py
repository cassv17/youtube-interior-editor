"""결과 배치 검증: 계산(화면 layout.ts와 같은 값), 검증 규칙, 실제 인코딩 결과(순서·빈칸·길이·자막 위치)."""
import json
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from backend.core import export, layout, media, nle, project, silence
from tests.test_export import fake_project

COLORS = [("red", (255, 0, 0)), ("green", (0, 128, 0)), ("blue", (0, 0, 255)),
          ("yellow", (255, 255, 0)), ("white", (255, 255, 255))]


def make_color_clip(path: Path) -> None:
    """2초씩 빨강·초록·파랑·노랑·흰색이 이어지는 10초 영상 + 계속 나는 440Hz 소리."""
    args = [media.ffmpeg(), "-y", "-loglevel", "error"]
    for name, _ in COLORS:
        args += ["-f", "lavfi", "-i", f"color=c={name}:s=320x180:r=30:d=2"]
    args += ["-f", "lavfi", "-i", "sine=f=440:r=44100:d=10"]
    cat = "".join(f"[{i}:v]" for i in range(len(COLORS))) + f"concat=n={len(COLORS)}:v=1:a=0[v]"
    args += ["-filter_complex", cat, "-map", "[v]", "-map", f"{len(COLORS)}:a",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)]
    media.run(args)


def frame_color(mp4: str, t: float) -> tuple[int, int, int]:
    raw = media.run([media.ffmpeg(), "-v", "error", "-ss", f"{t:.3f}", "-i", mp4, "-frames:v", "1",
                     "-vf", "scale=32:18", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout
    px = [raw[i:i + 3] for i in range(0, len(raw), 3)]
    return tuple(sum(p[c] for p in px) // len(px) for c in range(3))


def close(c, want, tol=40):
    return all(abs(a - b) <= tol for a, b in zip(c, want))


def it(id, a, b, gap=0.0):
    return {"id": id, "a": a, "b": b, "gap": gap}


class LayoutMathTest(unittest.TestCase):
    """layout.test.mjs 와 같은 값이 나와야 한다(화면과 결과 영상의 위치가 같아야 하므로)."""

    def pos(self, items, speeds=()):
        placed, _ = layout.place(items, list(speeds))
        return [(p.id, p.f0 / 30, p.f1 / 30) for p in placed]

    def test_place_with_gaps(self):
        self.assertEqual(self.pos([it("a", 0, 2), it("b", 5, 8)]), [("a", 0, 2), ("b", 2, 5)])
        self.assertEqual(self.pos([it("a", 0, 2, 1), it("b", 5, 8, 0.5)]), [("a", 1, 3), ("b", 3.5, 6.5)])

    def test_place_with_speed_uses_integer_frames(self):
        sp = [(2.0, 4.0, 2.0)]
        self.assertEqual(self.pos([it("a", 0, 6)], sp), [("a", 0, 5)])
        self.assertEqual(self.pos([it("a", 0, 2)], [(0.0, 2.0, 0.5)]), [("a", 0, 4)])
        atoms = layout.place([it("a", 0, 6)], sp)[0][0].atoms
        self.assertEqual([(a.a, a.b, a.speed, a.f0, a.f1) for a in atoms],
                         [(0, 2, 1, 0, 60), (2, 4, 2, 60, 90), (4, 6, 1, 90, 150)])

    def test_instances_follow_pieces(self):
        placed, _ = layout.place([it("b", 5, 8), it("a", 0, 2)], [])
        subs = [{"start": 1, "end": 1.5, "text": "a 안"}, {"start": 6, "end": 7, "text": "b 안"}]
        self.assertEqual(layout.instances(placed, subs), [(1.0, 2.0, "b 안"), (4.0, 4.5, "a 안")])

    def test_instances_split_across_gap_and_merge_when_touching(self):
        sub = [{"start": 1, "end": 6, "text": "길다"}]
        apart, _ = layout.place([it("a", 0, 2), it("b", 5, 8, 2)], [])
        self.assertEqual([(a, b) for a, b, _ in layout.instances(apart, sub)], [(1.0, 2.0), (4.0, 5.0)])
        joined, _ = layout.place([it("a", 0, 2), it("b", 5, 8)], [])
        self.assertEqual([(a, b) for a, b, _ in layout.instances(joined, sub)], [(1.0, 3.0)])

    def test_free_subtitles_are_skipped_by_instances(self):
        placed, _ = layout.place([it("a", 0, 2)], [])
        self.assertEqual(layout.instances(placed, [{"start": 0, "end": 1, "text": "x", "free": True}]), [])


class LayoutValidationTest(unittest.TestCase):
    def base(self):
        p = fake_project([(4.0, 5.0, True)], clips=((0.0, 10.0), (10.0, 5.0)))
        p["splits"] = [2.0]
        return p  # 남는 구간: [0,2] [2,4] [5,10] [10,15]

    def test_kept_pieces(self):
        self.assertEqual(layout.kept_pieces(self.base()), [(0.0, 2.0), (2.0, 4.0), (5.0, 10.0), (10.0, 15.0)])

    def test_default_or_missing_layout_means_old_path(self):
        p = self.base()
        self.assertIsNone(layout.items_of(p))
        p["layout"] = layout.default_items(p)
        self.assertIsNone(layout.items_of(p))
        self.assertIsNone(export.layout_sequence(p))

    def test_valid_custom_layout_is_accepted_and_snapped(self):
        p = self.base()
        items = layout.default_items(p)
        items[1]["gap"] = 0.51  # 격자(1/30)에 맞춰진다
        p["layout"] = items
        got = layout.items_of(p)
        self.assertIsNotNone(got)
        self.assertAlmostEqual(got[1]["gap"], 0.5, places=2)

    def test_reordered_layout_is_accepted(self):
        p = self.base()
        p["layout"] = list(reversed(layout.default_items(p)))
        self.assertEqual([x["a"] for x in layout.items_of(p)], [10.0, 5.0, 2.0, 0.0])

    def test_layout_that_does_not_tile_the_pieces_is_ignored(self):
        p = self.base()
        good = layout.default_items(p)
        for bad in (good[:-1],                                         # 조각 하나 빠짐
                    good + [it("dup", 0.0, 2.0)],                      # 같은 구간 두 번
                    [it("x", 0.0, 3.0)] + good[2:],                    # 경계가 안 맞음
                    [{"id": "z", "a": "abc", "b": 1}],                 # 숫자가 아님
                    "not a list"):
            p["layout"] = bad
            self.assertIsNone(layout.items_of(p), bad)

    def test_free_subtitles_land_at_their_output_time(self):
        p = self.base()
        p["subtitles"] = [{"start": 1.0, "end": 2.0, "text": "붙은 자막"},
                          {"start": 1.0, "end": 2.0, "text": "분리된 자막", "free": True, "e_start": 9.0, "e_end": 10.0}]
        out = export.output_subtitles(p)
        self.assertEqual([(s["start"], s["end"], s["text"]) for s in out],
                         [(1.0, 2.0, "붙은 자막"), (9.0, 10.0, "분리된 자막")])


class LayoutPersistTest(unittest.TestCase):
    def test_clean_layout_validates_numbers_and_ranges(self):
        from backend import jobs
        out = jobs.clean_layout([{"id": "a", "a": 0, "b": 2, "gap": 0.5}, {"id": "b", "a": 5, "b": 99, "gap": -3}], 10.0)
        self.assertEqual(out, [{"id": "a", "a": 0.0, "b": 2.0, "gap": 0.5}, {"id": "b", "a": 5.0, "b": 10.0, "gap": 0.0}])
        self.assertEqual(jobs.clean_layout([{"id": "a", "a": "x", "b": 2}], 10.0), [])
        self.assertEqual(jobs.clean_layout([{"id": "a", "a": 2, "b": 2.01}], 10.0), [])
        self.assertEqual(jobs.clean_layout("bad", 10.0), [])

    def test_reorder_moves_layout_pieces_with_clips_and_keeps_output_order(self):
        p = fake_project([], clips=((0.0, 10.0), (10.0, 5.0)))
        p["layout"] = [it("c2", 10.0, 15.0, 0.0), it("c1", 0.0, 10.0, 2.0)]  # 이미 순서가 바뀐 배치
        p["subtitles"] = [{"id": "s1", "clip_id": "c1", "start": 1.0, "end": 2.0, "text": "붙은", "words": []},
                          {"id": "f", "start": 3.0, "end": 4.0, "text": "분리", "free": True, "e_start": 9.0, "e_end": 10.0}]
        out = project.reorder(p, ["c2", "c1"], [])
        self.assertEqual([(x["id"], x["a"], x["b"], x["gap"]) for x in out["layout"]],
                         [("c2", 0.0, 5.0, 0.0), ("c1", 5.0, 15.0, 2.0)])  # E 순서·빈칸 그대로, 원본 구간만 이동
        subs = {s["id"]: s for s in out["subtitles"]}
        self.assertEqual((subs["s1"]["start"], subs["s1"]["end"]), (6.0, 7.0))         # 붙은 자막은 클립을 따라감
        self.assertEqual((subs["f"]["e_start"], subs["f"]["e_end"]), (9.0, 10.0))      # 분리된 자막은 그대로

    def test_apply_edits_cleans_free_subtitles(self):
        from backend import jobs
        import io
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a = root / "a.mp4"
            make_color_clip(a)
            orig = (jobs.PROJECTS_DIR, jobs.OUTPUT_DIR)
            jobs.PROJECTS_DIR, jobs.OUTPUT_DIR = root / "p", root / "o"
            jobs.PROJECTS_DIR.mkdir()
            try:
                pid = jobs.create_project([("a.mp4", io.BytesIO(a.read_bytes()))])["id"]
                built = project.build_project([a], silence.SilenceParams())
                built.update({"id": pid, "name": "t", "created": "x", "sources": jobs.load(pid)["sources"], "status": "ready"})
                jobs.save(pid, built)
                subs = [{"id": "ok", "start": 1, "end": 2, "text": "분리", "free": True, "e_start": 3, "e_end": 4},
                        {"id": "bad", "start": 1, "end": 2, "text": "짧음", "free": True, "e_start": 3, "e_end": 3.01},
                        {"id": "norm", "start": 5, "end": 6, "text": "일반", "e_start": 99}]
                data = jobs.apply_edits(pid, {"subtitles": subs, "layout": [{"id": "x", "a": 0, "b": 2, "gap": 1}]})
            finally:
                jobs.PROJECTS_DIR, jobs.OUTPUT_DIR = orig
            got = {s["id"]: s for s in data["subtitles"]}
            self.assertEqual(sorted(got), ["norm", "ok"])
            self.assertTrue(got["ok"]["free"])
            self.assertEqual((got["ok"]["e_start"], got["ok"]["e_end"]), (3.0, 4.0))
            self.assertNotIn("free", got["norm"])
            self.assertNotIn("e_start", got["norm"])
            self.assertEqual(data["layout"], [{"id": "x", "a": 0.0, "b": 2.0, "gap": 1.0}])


class LayoutEncodeTest(unittest.TestCase):
    """색이 구간마다 다른 영상을 실제로 인코딩해, 순서·빈칸·길이·소리·자막 위치를 확인한다."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.clip = cls.dir / "colors.mp4"
        make_color_clip(cls.clip)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def proj(self):
        p = project.build_project([self.clip], silence.SilenceParams())
        p["cuts"] = []
        p["splits"] = [2.0, 6.0]  # 조각: [0,2] 빨강 / [2,6] 초록·파랑 / [6,10] 노랑·흰색
        p["subtitles"] = [{"start": 7.0, "end": 7.5, "text": "노랑 자막"}, {"start": 1.0, "end": 1.5, "text": "빨강 자막"}]
        return p

    def probe(self, mp4: str) -> tuple[int, float]:
        info = json.loads(subprocess.run(
            [media.ffprobe(), "-v", "error", "-count_frames", "-show_entries",
             "stream=codec_type,nb_read_frames,duration", "-of", "json", mp4], capture_output=True, check=True).stdout)
        v = next(s for s in info["streams"] if s["codec_type"] == "video")
        a = next(s for s in info["streams"] if s["codec_type"] == "audio")
        return int(v["nb_read_frames"]), float(a["duration"])

    def test_reorder_and_gaps_end_to_end(self):
        p = self.proj()
        # 순서: [6,10] → 빈칸 1초 → [0,2] → 빈칸 0.5초 → [2,6]
        p["layout"] = [it("c", 6.0, 10.0, 0.0), it("a", 0.0, 2.0, 1.0), it("b", 2.0, 6.0, 0.5)]
        mp4 = self.dir / "out.mp4"
        total = export.encode(p, mp4, burn=False)
        expected = 4 + 1 + 2 + 0.5 + 4  # 11.5초
        self.assertAlmostEqual(total, expected, places=3)
        frames, audio = self.probe(str(mp4))
        self.assertEqual(frames, round(expected * 30))
        self.assertAlmostEqual(audio, expected, delta=0.06)

        want = {1.0: (255, 255, 0),     # 노랑(원본 7초)
                3.0: (255, 255, 255),   # 흰색(원본 9초)
                4.5: (0, 0, 0),         # 빈칸 = 검은 화면
                6.0: (255, 0, 0),       # 빨강(원본 1초)
                8.5: (0, 128, 0),       # 초록(원본 3초)
                10.5: (0, 0, 255)}      # 파랑(원본 5.5초)
        for t, rgb in want.items():
            self.assertTrue(close(frame_color(str(mp4), t), rgb), (t, frame_color(str(mp4), t), rgb))

        # 빈칸 소리는 무음, 조각 안은 소리가 난다
        levels = silence.measure_levels(str(mp4))
        gap_db = [levels[i] for i in range(int(4.1 / 0.02), int(4.9 / 0.02))]
        tone_db = [levels[i] for i in range(int(1.0 / 0.02), int(3.0 / 0.02))]
        self.assertLess(max(gap_db), -60)
        self.assertGreater(sum(tone_db) / len(tone_db), -30)

        subs = export.output_subtitles(p)
        self.assertEqual([(s["start"], s["end"], s["text"]) for s in subs],
                         [(1.0, 1.5, "노랑 자막"), (6.0, 6.5, "빨강 자막")])

    def test_layout_with_speed_and_leading_gap(self):
        p = self.proj()
        p["speed_ranges"] = [{"id": "s", "start": 2.0, "end": 4.0, "speed": 2.0}]  # 초록 2초 → 1초
        p["layout"] = [it("b", 2.0, 6.0, 1.0), it("a", 0.0, 2.0, 0.0), it("c", 6.0, 10.0, 0.0)]
        mp4 = self.dir / "out2.mp4"
        total = export.encode(p, mp4, burn=False)
        expected = 1 + (1 + 2) + 2 + 4  # 빈칸 + b(초록 2배속 1초 + 파랑 2초) + a + c
        self.assertAlmostEqual(total, expected, places=3)
        frames, audio = self.probe(str(mp4))
        self.assertEqual(frames, round(expected * 30))
        self.assertAlmostEqual(audio, expected, delta=0.06)
        for t, rgb in {0.5: (0, 0, 0), 1.5: (0, 128, 0), 3.0: (0, 0, 255), 4.5: (255, 0, 0), 6.5: (255, 255, 0)}.items():
            self.assertTrue(close(frame_color(str(mp4), t), rgb), (t, frame_color(str(mp4), t), rgb))

    def test_default_layout_still_uses_the_old_exact_path(self):
        p = self.proj()
        p["layout"] = layout.default_items(p)
        self.assertIsNone(export.layout_sequence(p))
        mp4 = self.dir / "out3.mp4"
        export.encode(p, mp4, burn=False)
        frames, _ = self.probe(str(mp4))
        self.assertEqual(frames, 300)

    def test_xml_places_clips_with_gaps_and_reordered(self):
        p = self.proj()
        p["layout"] = [it("c", 6.0, 10.0, 0.0), it("a", 0.0, 2.0, 1.0), it("b", 2.0, 6.0, 0.5)]
        seq = export.layout_sequence(p)
        xml = nle.to_xml(p, {}, {p["clips"][0]["id"]: self.clip}, "t", sequence=seq)
        root = ET.fromstring(xml.split("<!DOCTYPE xmeml>\n")[1])
        v = root.findall("./sequence/media/video/track/clipitem")
        self.assertEqual([(int(c.find("start").text), int(c.find("end").text)) for c in v],
                         [(0, 120), (150, 210), (225, 345)])          # 빈칸 30프레임, 15프레임
        self.assertEqual([(int(c.find("in").text), int(c.find("out").text)) for c in v],
                         [(180, 300), (0, 60), (60, 180)])           # 원본 6~10 / 0~2 / 2~6
        self.assertEqual(root.find("./sequence/duration").text, "345")


if __name__ == "__main__":
    unittest.main()
