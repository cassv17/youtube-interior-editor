"""레퍼런스 분석 검증: 우리 앱의 자막 렌더러로 스타일을 알고 있는 영상을 만든 뒤, 분석 결과가 되돌아오는지 본다."""
import subprocess
import tempfile
import unittest
from pathlib import Path

from backend.core import export, media, project, reference

W, H, DUR = 1280, 720, 30.0


def make_reference(path: Path, style: dict | None, tone: float = 1.0, gap: float = 0.3,
                   with_audio: bool = True) -> None:
    """tone초 말 + gap초 쉼을 반복하는 소리, 움직이는 그라데이션 배경, (있으면) 바뀌는 자막."""
    period = tone + gap
    n = int(DUR // period)
    gate = "+".join(f"between(t,{i * period:.3f},{i * period + tone:.3f})" for i in range(n))
    expr = f"0.03*(2*random(0)-1)+0.3*sin(2*PI*220*t)*({gate})"
    with tempfile.TemporaryDirectory() as td:
        args = [media.ffmpeg(), "-y", "-loglevel", "error",
                "-f", "lavfi", "-i", f"gradients=s={W}x{H}:r=30:d={DUR}:speed=0.02"]
        if with_audio:
            args += ["-f", "lavfi", "-i", f"aevalsrc='{expr}':s=44100:d={DUR}"]
        if style:
            subs = [{"start": i * period, "end": i * period + tone, "text": f"자막 테스트 문장 {i + 1}번입니다"}
                    for i in range(n)]
            (Path(td) / "s.ass").write_text(export.to_ass(subs, style, W, H), encoding="utf-8")
            args += ["-vf", "ass=s.ass"]
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
        args += ["-c:a", "aac", "-shortest"] if with_audio else ["-an"]
        args += [str(path.resolve())]
        subprocess.run(args, check=True, cwd=td, creationflags=media.NO_WINDOW)


class ReferenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _style(self, **kw) -> dict:
        return {**project.DEFAULT_STYLE, **kw}

    def test_subtitle_style_round_trip(self):
        for kw in (
            dict(position="bottom", margin=6.0, size=5.0, color="#FFFFFF"),
            dict(position="top", margin=8.0, size=6.5, color="#FFE000"),
            dict(position="bottom", margin=12.0, size=4.0, color="#FFFFFF"),
        ):
            with self.subTest(**kw):
                p = self.dir / f"ref_{kw['position']}_{kw['margin']}.mp4"
                make_reference(p, self._style(**kw))
                r = reference.analyze_subtitle_style(str(p), media.probe(p))
                self.assertTrue(r["ok"], r)
                s = r["style"]
                self.assertEqual(s["position"], kw["position"])
                self.assertAlmostEqual(s["margin"], kw["margin"], delta=2.0)
                self.assertAlmostEqual(s["size"], kw["size"], delta=kw["size"] * 0.25)
                want = [int(kw["color"][i:i + 2], 16) for i in (1, 3, 5)]
                got = [int(s["color"][i:i + 2], 16) for i in (1, 3, 5)]
                self.assertTrue(all(abs(a - b) <= 40 for a, b in zip(want, got)), (kw["color"], s["color"]))

    def test_no_subtitle_returns_not_ok(self):
        p = self.dir / "ref_plain.mp4"
        make_reference(p, None)
        r = reference.analyze_subtitle_style(str(p), media.probe(p))
        self.assertFalse(r["ok"], r)

    def test_rhythm_from_pauses(self):
        p = self.dir / "ref_rhythm.mp4"
        make_reference(p, None, tone=1.0, gap=0.3)
        r = reference.analyze_rhythm(str(p))
        self.assertTrue(r["ok"], r)
        self.assertAlmostEqual(r["median_pause"], 0.3, delta=0.08)
        self.assertAlmostEqual(r["silence"]["pad"], 0.15, delta=0.05)
        self.assertGreaterEqual(r["silence"]["min_silence"], 2 * r["silence"]["pad"] + 0.2 - 1e-9)

    def test_slower_reference_gives_looser_settings(self):
        fast, slow = self.dir / "fast.mp4", self.dir / "slow.mp4"
        make_reference(fast, None, tone=1.0, gap=0.2)
        make_reference(slow, None, tone=1.0, gap=0.8)
        rf, rs = reference.analyze_rhythm(str(fast)), reference.analyze_rhythm(str(slow))
        self.assertLess(rf["silence"]["pad"], rs["silence"]["pad"])
        self.assertLess(rf["silence"]["min_silence"], rs["silence"]["min_silence"])

    def test_no_audio_is_reported(self):
        p = self.dir / "ref_mute.mp4"
        make_reference(p, None, with_audio=False)
        r = reference.analyze(str(p))
        self.assertFalse(r["rhythm"]["ok"])


if __name__ == "__main__":
    unittest.main()
