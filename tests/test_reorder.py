"""클립 순서 바꾸기(컷·자막 세트 이동), 그룹 검증, 프리미어용 XML 구조."""
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from backend.core import export, nle, project


def make():
    return {
        "duration": 15.0,
        "output": {"width": 1920, "height": 1080, "fps": 30},
        "clips": [
            {"id": "c1", "name": "a.mp4", "offset": 0.0, "duration": 10.0, "fps": 30, "width": 1920, "height": 1080},
            {"id": "c2", "name": "b.mp4", "offset": 10.0, "duration": 5.0, "fps": 29.97, "width": 1920, "height": 1080},
        ],
        "cuts": [
            {"id": "x1", "clip_id": "c1", "start": 2.0, "end": 3.0, "enabled": True, "origin": "silence"},
            {"id": "x2", "clip_id": "c2", "start": 11.0, "end": 12.0, "enabled": True, "origin": "silence"},
            {"id": "u", "clip_id": "c1", "start": 9.0, "end": 11.0, "enabled": True, "origin": "user"},  # 경계를 넘음
        ],
        "subtitles": [
            {"id": "s1", "clip_id": "c1", "start": 1.0, "end": 2.0, "text": "첫", "words": [{"w": "첫", "s": 1.0, "e": 2.0, "p": 1}]},
            {"id": "s2", "clip_id": "c2", "start": 13.0, "end": 14.0, "text": "둘", "words": [{"w": "둘", "s": 13.0, "e": 14.0, "p": 1}]},
        ],
    }


class ReorderTest(unittest.TestCase):
    def test_clips_move_with_their_cuts_and_subtitles(self):
        p = project.reorder(make(), ["c2", "c1"], [])
        self.assertEqual([(c["id"], c["offset"]) for c in p["clips"]], [("c2", 0.0), ("c1", 5.0)])
        spans = {(c["clip_id"], c["start"], c["end"]) for c in p["cuts"]}
        # c2 컷 11~12 → 1~2, c1 컷 2~3 → 7~8, 경계 컷 9~11은 c1(14~15) + c2(0~1)로 나뉨
        self.assertEqual(spans, {("c2", 1.0, 2.0), ("c1", 7.0, 8.0), ("c1", 14.0, 15.0), ("c2", 0.0, 1.0)})
        subs = {s["id"]: (s["start"], s["end"], s["words"][0]["s"]) for s in p["subtitles"]}
        self.assertEqual(subs, {"s2": (3.0, 4.0, 3.0), "s1": (6.0, 7.0, 6.0)})
        self.assertEqual(p["duration"], 15.0)

    def test_subtitle_starting_exactly_at_boundary_is_kept(self):
        p = make()
        # 부동소수 오차로 경계가 10.0000003처럼 저장된 경우
        p["clips"][0]["duration"] = 10.0000003
        p["subtitles"].append({"id": "s3", "clip_id": "c2", "start": 10.0, "end": 11.0, "text": "경계", "words": []})
        out = project.reorder(p, ["c2", "c1"], [])
        s3 = next(s for s in out["subtitles"] if s["id"] == "s3")
        self.assertEqual((s3["start"], s3["end"], s3["clip_id"]), (0.0, 1.0, "c2"))

    def test_round_trip_restores_original(self):
        orig = make()
        p = project.reorder(project.reorder(make(), ["c2", "c1"], []), ["c1", "c2"], [])
        self.assertEqual([s["start"] for s in p["subtitles"]], [s["start"] for s in orig["subtitles"]])
        self.assertEqual(sorted((c["start"], c["end"]) for c in p["cuts"] if c["origin"] != "user"),
                         sorted((c["start"], c["end"]) for c in orig["cuts"] if c["origin"] != "user"))

    def test_group_must_be_contiguous(self):
        p = make()
        p["clips"].append({"id": "c3", "name": "c.mp4", "offset": 15.0, "duration": 1.0})
        p["duration"] = 16.0
        with self.assertRaises(ValueError):
            project.reorder(p, ["c1", "c2", "c3"], [{"clips": ["c1", "c3"]}])
        ok = project.reorder(make(), ["c1", "c2"], [{"name": "거실", "clips": ["c2", "c1"]}])
        self.assertEqual(ok["groups"], [{"id": "g1", "name": "거실", "clips": ["c1", "c2"]}])


class XmlTest(unittest.TestCase):
    def test_xml_structure(self):
        p = make()
        p["cuts"] = [c for c in p["cuts"] if c["id"] != "u"]
        cuts = export.merged_cuts(p)
        segs = export.keep_segments(p, cuts)
        media = {"c1": Path("C:/영상/a.mp4"), "c2": Path("C:/영상/b.mp4")}
        root = ET.fromstring(nle.to_xml(p, segs, media, "테스트").split("\n", 2)[2])
        seq = root.find("sequence")
        self.assertEqual(int(seq.find("duration").text), 13 * 30)  # 15초 - 컷 2초
        vitems = seq.findall("./media/video/track/clipitem")
        self.assertEqual(len(vitems), 4)  # c1: 0~2, 3~10 / c2: 0~1, 2~5
        self.assertEqual([(int(i.find("start").text), int(i.find("end").text)) for i in vitems],
                         [(0, 60), (60, 270), (270, 300), (300, 390)])
        # 29.97 클립은 원본 프레임 기준 in/out
        last = vitems[-1]
        self.assertEqual((int(last.find("in").text), int(last.find("out").text)), (round(2 * 29.97), round(5 * 29.97)))
        self.assertEqual(last.find("rate/ntsc").text, "TRUE")
        self.assertEqual(len(seq.findall("./media/audio/track")), 2)
        self.assertIn("file://localhost/C:/%EC%98%81%EC%83%81/a.mp4", nle.to_xml(p, segs, media, "t"))


if __name__ == "__main__":
    unittest.main()
