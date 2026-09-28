"""무음 감지 검증: 정답을 아는 합성 영상으로 컷 위치를 확인한다.

실행: python -m unittest discover tests
"""
import tempfile
import unittest
from pathlib import Path

from backend.core import media, project, silence

# 차 안 소음 흉내(상시 잡음) + 말소리 흉내(220Hz 톤)를 아래 구간에만 넣는다.
TONE = [(1.0, 3.0), (4.5, 6.0), (6.3, 8.0)]  # 6.0~6.3의 0.3초 쉼은 min_silence(0.6)보다 짧아 컷되면 안 됨
DURATION = 10.0


def make_clip(path: Path) -> None:
    gate = "+".join(f"between(t,{a},{b})" for a, b in TONE)
    expr = f"0.03*(2*random(0)-1)+0.3*sin(2*PI*220*t)*({gate})"
    media.run([
        media.ffmpeg(), "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=gray:s=320x180:r=30:d={DURATION}",
        "-f", "lavfi", "-i", f"aevalsrc='{expr}':s=44100:d={DURATION}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path),
    ])


class SilenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.a = Path(cls.tmp.name) / "a.mp4"
        cls.b = Path(cls.tmp.name) / "b.mp4"
        make_clip(cls.a)
        make_clip(cls.b)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def assertNear(self, got, want, tol=0.06):
        self.assertLess(abs(got - want), tol, f"{got} != {want} (±{tol})")

    def test_single_clip_cuts(self):
        params = silence.SilenceParams()  # auto, min_silence 0.6, pad 0.15
        info = media.probe(self.a)
        cuts = silence.detect(info["path"], info["duration"], params)["cuts"]
        expected = [(0.0, 1.0 - 0.15), (3.0 + 0.15, 4.5 - 0.15), (8.0 + 0.15, DURATION)]
        self.assertEqual(len(cuts), len(expected), cuts)
        for c, (s, e) in zip(cuts, expected):
            self.assertNear(c["start"], s)
            self.assertNear(c["end"], e)

    def test_fixed_threshold_too_low_finds_nothing(self):
        # 소음(-33dB 부근)보다 낮은 고정 기준이면 무음이 없어야 한다 → auto가 필요한 이유
        info = media.probe(self.a)
        params = silence.SilenceParams(threshold=-50)
        self.assertEqual(silence.detect(info["path"], info["duration"], params)["cuts"], [])

    def test_multi_clip_timeline_offsets(self):
        proj = project.build_project([self.a, self.b], silence.SilenceParams())
        self.assertNear(proj["clips"][1]["offset"], proj["clips"][0]["duration"], 0.01)
        second = [c for c in proj["cuts"] if c["clip_id"] == "c2"]
        off = proj["clips"][1]["offset"]
        self.assertNear(second[0]["start"], off + 0.0)
        self.assertNear(second[1]["start"], off + 3.15)
        for c in proj["cuts"]:  # 컷은 클립 경계를 넘지 않는다
            clip = next(k for k in proj["clips"] if k["id"] == c["clip_id"])
            self.assertGreaterEqual(c["start"], clip["offset"] - 1e-6)
            self.assertLessEqual(c["end"], clip["offset"] + clip["duration"] + 1e-6)

    def test_source_file_untouched(self):
        before = (self.a.stat().st_size, self.a.stat().st_mtime_ns)
        project.build_project([self.a], silence.SilenceParams())
        self.assertEqual(before, (self.a.stat().st_size, self.a.stat().st_mtime_ns))


if __name__ == "__main__":
    unittest.main()
