"""레이어(트랙) 검증: 트랙·합성 항목 검증, 합성 계획, 실제 합성 결과(우선순위·위치·투명도·소리·길이), 자막 레이어, XML."""
import io
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from backend import jobs
from backend.core import assets, export, layers, media, project, silence
from tests.test_layout import frame_color, close, make_color_clip


def make_image(path: Path, color: str = "blue", size: str = "200x200") -> None:
    media.run([media.ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={color}:s={size}",
               "-frames:v", "1", str(path)])


def make_audio(path: Path, freq: int = 880, dur: float = 4.0) -> None:
    media.run([media.ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i", f"sine=f={freq}:r=44100:d={dur}", str(path)])


def make_video(path: Path, color: str = "green", dur: float = 3.0) -> None:
    media.run([media.ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={color}:s=320x180:r=30:d={dur}",
               "-f", "lavfi", "-i", f"sine=f=660:r=44100:d={dur}", "-c:v", "libx264", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-shortest", str(path)])


class TrackValidationTest(unittest.TestCase):
    def test_defaults_have_three_of_each_kind_with_main_tracks(self):
        t = layers.default_tracks()
        for kind in ("subtitle", "video", "audio"):
            self.assertGreaterEqual(sum(1 for x in t if x["kind"] == kind), 3)
        self.assertEqual([x["id"] for x in t if x["kind"] == "video"], ["V3", "V2", "V1"])  # 위 → 아래, 메인이 맨 아래
        self.assertTrue(next(x for x in t if x["id"] == "V1")["main"])

    def test_clean_tracks_repairs_and_limits(self):
        out = layers.clean_tracks([
            {"id": "V1", "kind": "video", "name": "x" * 50, "main": True, "hidden": True},   # 메인 영상은 숨길 수 없다
            {"id": "V2", "kind": "video", "hidden": True},
            {"id": "V2", "kind": "video"},                                                    # 중복 id
            {"id": "bad id!", "kind": "video"},
            {"id": "A2", "kind": "audio", "volume": 9, "muted": True},
            {"id": "S1", "kind": "subtitle", "style": {"position": "top", "color": "red", "size": 99}},
            {"id": "Z", "kind": "weird"},
        ])
        ids = [x["id"] for x in out]
        self.assertEqual(ids.count("V2"), 1)
        self.assertNotIn("bad id!", ids)
        v1 = next(x for x in out if x["id"] == "V1")
        self.assertEqual(len(v1["name"]), 20)
        self.assertFalse(v1["hidden"])
        self.assertEqual(next(x for x in out if x["id"] == "A2")["volume"], 2.0)
        self.assertEqual(next(x for x in out if x["id"] == "S1")["style"], {"position": "top", "size": 12.0})
        self.assertIn("A1", ids)                       # 없던 메인 음성은 만들어진다
        kinds = [x["kind"] for x in out]
        self.assertEqual(kinds, sorted(kinds, key=lambda k: layers.KIND_ORDER[k]))   # 자막 → 영상 → 음성
        self.assertEqual([x["id"] for x in out if x["kind"] == "video"][-1], "V1")   # 메인 영상이 맨 아래

    def test_empty_or_garbage_gives_usable_tracks(self):
        for raw in (None, [], "x", [1, 2]):
            ids = [x["id"] for x in layers.clean_tracks(raw)]
            self.assertIn("V1", ids)
            self.assertIn("A1", ids)
            self.assertTrue(any(i.startswith("S") for i in ids))

    def test_subtitle_layer_numbers_put_upper_tracks_in_front(self):
        p = {}
        self.assertGreater(layers.subtitle_layer(p, "S3"), layers.subtitle_layer(p, "S2"))
        self.assertGreater(layers.subtitle_layer(p, "S2"), layers.subtitle_layer(p, "S1"))
        self.assertEqual(layers.default_subtitle_track(p), "S1")
        self.assertEqual(layers.subtitle_track(p, {"track": "nope"}), "S1")
        self.assertEqual(layers.subtitle_track(p, {"track": "S3"}), "S3")


class OverlayValidationTest(unittest.TestCase):
    def proj(self):
        return {"assets": [{"id": "img", "kind": "image", "duration": 5.0, "has_audio": False},
                           {"id": "mus", "kind": "audio", "duration": 10.0, "has_audio": True},
                           {"id": "vid", "kind": "video", "duration": 4.0, "has_audio": True}],
                "clips": [{"id": "c1", "duration": 8.0, "has_audio": True}], "duration": 8.0}

    def test_valid_items_are_kept_and_clamped(self):
        out = layers.clean_overlays([
            {"id": "a", "track": "V2", "type": "image", "src": "img", "start": 1, "dur": 99999, "scale": 99, "opacity": 3, "x": 9},
            {"id": "b", "track": "A2", "type": "audio", "src": "mus", "start": 0, "src_in": 2, "src_out": 99, "volume": 7, "fade_in": 50},
            {"id": "c", "track": "V3", "type": "clip", "src": "c1", "src_in": 1, "src_out": 3, "start": 5},
        ], self.proj())
        by = {o["id"]: o for o in out}
        self.assertEqual(by["a"]["dur"], 3600.0)
        self.assertEqual((by["a"]["scale"], by["a"]["opacity"], by["a"]["x"]), (4.0, 1.0, 2.0))
        self.assertEqual((by["b"]["src_in"], by["b"]["src_out"], by["b"]["volume"]), (2.0, 10.0, 2.0))
        self.assertEqual(by["b"]["fade_in"], 8.0)           # 길이를 넘지 못한다
        self.assertEqual((by["c"]["src_in"], by["c"]["src_out"], by["c"]["dur"]), (1.0, 3.0, 2.0))
        self.assertTrue(by["c"]["has_audio"])

    def test_invalid_items_are_dropped(self):
        bad = [
            {"id": "1", "track": "V2", "type": "image", "src": "missing"},              # 없는 자료
            {"id": "2", "track": "V2", "type": "audio", "src": "mus"},                  # 영상 트랙에 음악
            {"id": "3", "track": "A2", "type": "video", "src": "vid"},                  # 음성 트랙에 영상
            {"id": "4", "track": "V1", "type": "image", "src": "img"},                  # 메인 영상 트랙
            {"id": "5", "track": "S1", "type": "image", "src": "img"},                  # 자막 트랙
            {"id": "6", "track": "V9", "type": "image", "src": "img"},                  # 없는 트랙
            {"id": "7", "track": "V2", "type": "video", "src": "img"},                  # 종류가 안 맞는 자료
            {"id": "8", "track": "V2", "type": "clip", "src": "nope"},                  # 없는 클립
            {"id": "9", "track": "V2", "type": "video", "src": "vid", "src_in": 3.95, "src_out": 4.0},  # 너무 짧음
            "garbage", None,
        ]
        self.assertEqual(layers.clean_overlays(bad, self.proj()), [])

    def test_markers(self):
        out = layers.clean_markers([{"t": 5, "name": "b"}, {"t": 1, "name": "a" * 99}, {"t": "x"}, "z"])
        self.assertEqual([m["t"] for m in out], [1.0, 5.0])
        self.assertEqual(len(out[0]["name"]), 40)


class PlanTest(unittest.TestCase):
    def proj(self):
        return {
            "assets": [{"id": "img", "kind": "image", "path": "i.png", "duration": 5.0, "has_audio": False, "name": "i.png", "width": 100, "height": 100},
                       {"id": "mus", "kind": "audio", "path": "m.wav", "duration": 10.0, "has_audio": True, "name": "m.wav"}],
            "clips": [], "duration": 10.0, "overlays": [],
        }

    def test_upper_track_is_drawn_last_and_hidden_or_muted_tracks_are_skipped(self):
        p = self.proj()
        p["overlays"] = [
            {"id": "a", "track": "V3", "type": "image", "src": "img", "start": 0, "dur": 2, "src_in": 0, "src_out": 2},
            {"id": "b", "track": "V2", "type": "image", "src": "img", "start": 0, "dur": 2, "src_in": 0, "src_out": 2},
            {"id": "m", "track": "A2", "type": "audio", "src": "mus", "start": 1, "dur": 3, "src_in": 0, "src_out": 3, "volume": 0.5, "has_audio": True},
        ]
        plan = layers.build_plan(p)
        self.assertEqual([v.id for v in plan.visuals], ["b", "a"])         # 아래(V2) → 위(V3)
        self.assertEqual([a.id for a in plan.audios], ["m"])
        self.assertEqual(plan.end_f, 120)
        p["tracks"] = [dict(t, hidden=True) if t["id"] == "V3" else dict(t, muted=True) if t["id"] == "A2" else t
                       for t in layers.default_tracks()]
        plan = layers.build_plan(p)
        self.assertEqual([v.id for v in plan.visuals], ["b"])
        self.assertEqual(plan.audios, [])

    def test_empty_plan_means_old_path(self):
        self.assertTrue(layers.build_plan(self.proj()).empty)
        p = self.proj()
        p["tracks"] = [dict(t, volume=0.5) if t["id"] == "A1" else t for t in layers.default_tracks()]
        self.assertFalse(layers.build_plan(p).empty)                        # 메인 음량만 바꿔도 반영해야 한다


class LayerEncodeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.clip = cls.dir / "colors.mp4"
        make_color_clip(cls.clip)                       # 0~2 빨강, 2~4 초록, 4~6 파랑, 6~8 노랑, 8~10 흰색 + 440Hz
        cls.blue_png = cls.dir / "blue.png"
        make_image(cls.blue_png, "blue")
        cls.white_png = cls.dir / "white.png"
        make_image(cls.white_png, "white", "320x180")   # 화면과 같은 비율이라 전체를 덮는다
        cls.music = cls.dir / "music.wav"
        make_audio(cls.music, 880, 4.0)
        cls.vid = cls.dir / "b.mp4"
        make_video(cls.vid, "yellow", 3.0)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def proj(self):
        p = project.build_project([self.clip], silence.SilenceParams())
        p["cuts"] = []
        p["subtitles"] = []
        p["assets"] = [
            {"id": "blue", "name": "blue.png", "kind": "image", "path": str(self.blue_png), "duration": 5.0,
             "width": 200, "height": 200, "has_audio": False},
            {"id": "white", "name": "white.png", "kind": "image", "path": str(self.white_png), "duration": 5.0,
             "width": 320, "height": 180, "has_audio": False},
            {"id": "mus", "name": "music.wav", "kind": "audio", "path": str(self.music), "duration": 4.0,
             "width": 0, "height": 0, "has_audio": True},
            {"id": "vid", "name": "b.mp4", "kind": "video", "path": str(self.vid), "duration": 3.0,
             "width": 320, "height": 180, "has_audio": True},
        ]
        return p

    def ov(self, p, items):
        p["overlays"] = layers.clean_overlays(items, p)
        return p

    def render(self, p, name):
        mp4 = self.dir / name
        total = export.encode(p, mp4, burn=False)
        return str(mp4), total

    def test_upper_layer_covers_lower_and_pip_position_and_scale(self):
        p = self.ov(self.proj(), [
            {"id": "g", "track": "V2", "type": "image", "src": "white", "start": 0, "dur": 2, "scale": 1.0},          # 전체 덮기
            {"id": "b", "track": "V3", "type": "image", "src": "blue", "start": 1, "dur": 2, "scale": 0.5, "x": 0.8, "y": 0.2},
        ])
        mp4, total = self.render(p, "l1.mp4")
        self.assertAlmostEqual(total, 10.0, places=2)
        self.assertTrue(close(frame_color(mp4, 0.5), (255, 255, 255)))                 # V2 흰 이미지가 빨강을 덮음
        self.assertTrue(close(frame_color(mp4, 3.5), (0, 128, 0)))                      # 오버레이가 끝난 뒤 → 원본(초록 구간)
        # 1.5초: V3의 작은 파랑이 오른쪽 위에, 나머지는 V2 흰색
        px = lambda x, y: self._pixel(mp4, 1.5, x, y)
        self.assertTrue(close(px(0.8, 0.2), (0, 0, 255)), px(0.8, 0.2))                 # PIP 위치
        self.assertTrue(close(px(0.2, 0.8), (255, 255, 255)), px(0.2, 0.8))             # 그 밖은 V2
        self.assertTrue(close(px(0.5, 0.5), (255, 255, 255)), px(0.5, 0.5))

    def _pixel(self, mp4: str, t: float, fx: float, fy: float) -> tuple[int, int, int]:
        raw = media.run([media.ffmpeg(), "-v", "error", "-ss", f"{t:.3f}", "-i", mp4, "-frames:v", "1",
                         "-vf", "scale=100:56", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout
        x, y = int(fx * 99), int(fy * 55)
        i = (y * 100 + x) * 3
        return raw[i], raw[i + 1], raw[i + 2]

    def test_opacity_blends_with_the_layer_below(self):
        p = self.ov(self.proj(), [{"id": "w", "track": "V2", "type": "image", "src": "white", "start": 0, "dur": 2, "opacity": 0.5}])
        mp4, _ = self.render(p, "l2.mp4")
        r, g, b = frame_color(mp4, 1.0)                  # 빨강(255,0,0) 위에 흰색 50% → 약 (236,124,124)
        self.assertTrue(r > 225 and 100 < g < 150 and 100 < b < 150, (r, g, b))

    def test_overlay_video_plays_from_its_own_start_and_clip_layer_uses_the_main_footage(self):
        p = self.ov(self.proj(), [
            {"id": "v", "track": "V2", "type": "video", "src": "vid", "start": 6, "src_in": 0, "src_out": 2},          # 노랑 영상
            {"id": "c", "track": "V3", "type": "clip", "src": p_clip_id(self.proj()), "start": 0, "src_in": 8, "src_out": 10, "scale": 1.0},
        ])
        mp4, _ = self.render(p, "l3.mp4")
        self.assertTrue(close(frame_color(mp4, 1.0), (255, 255, 255)))                   # V3: 메인 클립의 8~10초(흰색)가 0~2초에 올라옴
        self.assertTrue(close(frame_color(mp4, 7.0), (255, 255, 0)))                     # 6~8초: V2 노랑 영상(원래도 노랑 구간이라 색은 같다)
        self.assertTrue(close(frame_color(mp4, 3.0), (0, 128, 0)))                       # 그 밖은 원본

    def test_audio_layers_mix_and_main_mute_and_volume(self):
        p = self.ov(self.proj(), [{"id": "m", "track": "A2", "type": "audio", "src": "mus", "start": 2, "volume": 1.0}])
        p["tracks"] = [dict(t, muted=True) if t["id"] == "A1" else t for t in layers.default_tracks()]
        mp4, total = self.render(p, "l4.mp4")
        self.assertAlmostEqual(total, 10.0, places=2)
        levels = silence.measure_levels(mp4)
        at = lambda a, b: [levels[i] for i in range(int(a / 0.02), int(b / 0.02))]
        self.assertLess(max(at(0.2, 1.8)), -60)                       # 메인 소리 음소거 + 음악은 2초부터
        self.assertGreater(sum(at(2.3, 3.7)) / len(at(2.3, 3.7)), -25)  # 음악이 들림
        self.assertLess(max(at(6.3, 9.7)), -60)                        # 음악(4초)이 끝난 뒤 무음

        p2 = self.ov(self.proj(), [])
        base = silence.measure_levels(self.render(p2, "l4b.mp4")[0])
        p2["tracks"] = [dict(t, volume=0.5) if t["id"] == "A1" else t for t in layers.default_tracks()]
        half = silence.measure_levels(self.render(p2, "l4c.mp4")[0])
        mean = lambda L: sum(L[100:400]) / 300
        self.assertAlmostEqual(mean(base) - mean(half), 6.0, delta=1.0)  # 볼륨 50% = 약 -6dB

    def test_item_volume_and_fade(self):
        p = self.ov(self.proj(), [{"id": "m", "track": "A2", "type": "audio", "src": "mus", "start": 0, "volume": 1.0, "fade_in": 1.0}])
        p["tracks"] = [dict(t, muted=True) if t["id"] == "A1" else t for t in layers.default_tracks()]
        levels = silence.measure_levels(self.render(p, "l5.mp4")[0])
        early = sum(levels[2:10]) / 8                  # 0.04~0.2초: 페이드 시작 직후라 작다
        late = sum(levels[100:140]) / 40               # 2~2.8초: 정상 크기
        self.assertGreater(late - early, 12)

    def test_layers_can_extend_the_result_beyond_the_main_track(self):
        p = self.ov(self.proj(), [{"id": "m", "track": "A2", "type": "audio", "src": "mus", "start": 9, "volume": 1.0}])
        mp4, total = self.render(p, "l6.mp4")
        self.assertAlmostEqual(total, 13.0, places=2)    # 9초 + 음악 4초
        self.assertTrue(close(frame_color(mp4, 11.0), (0, 0, 0)))   # 메인이 끝난 뒤는 검은 화면

    def test_no_layers_keeps_the_old_exact_path(self):
        p = self.proj()
        self.assertTrue(layers.build_plan(p).empty)
        mp4, total = self.render(p, "l7.mp4")
        self.assertAlmostEqual(total, 10.0, places=2)

    def test_lifted_clip_layer_carries_its_subtitles_but_a_copy_does_not(self):
        p = self.proj()
        cid = p["clips"][0]["id"]
        p["cuts"] = [{"id": "x", "clip_id": cid, "start": 6.0, "end": 10.0, "enabled": True, "origin": "user",
                      "needs_review": False, "review_reasons": []}]            # 6~10초를 메인에서 뺌
        p["subtitles"] = [{"id": "a", "start": 1, "end": 2, "text": "메인에 남은 자막", "clip_id": cid, "words": []},
                          {"id": "b", "start": 7, "end": 8, "text": "올라간 조각의 자막", "clip_id": cid, "words": []}]
        self.ov(p, [{"id": "c", "track": "V2", "type": "clip", "src": cid, "src_in": 6, "src_out": 10, "start": 12, "carry_subs": True}])
        subs = {s["text"]: (s["start"], s["end"]) for s in export.output_subtitles(p)}
        self.assertEqual(subs["메인에 남은 자막"], (1.0, 2.0))
        self.assertEqual(subs["올라간 조각의 자막"], (13.0, 14.0))              # 12 + (7-6)
        self.ov(p, [{"id": "c", "track": "V2", "type": "clip", "src": cid, "src_in": 6, "src_out": 10, "start": 12}])   # 복사: 자막 안 가져감
        self.assertEqual([s["text"] for s in export.output_subtitles(p)], ["메인에 남은 자막"])
        # 숨긴 레이어로 올라간 조각의 자막은 나오지 않는다
        self.ov(p, [{"id": "c", "track": "V2", "type": "clip", "src": cid, "src_in": 6, "src_out": 10, "start": 12, "carry_subs": True}])
        p["tracks"] = [dict(t, hidden=True) if t["id"] == "V2" else t for t in layers.default_tracks()]
        self.assertEqual([s["text"] for s in export.output_subtitles(p)], ["메인에 남은 자막"])

    def test_subtitle_layers_have_their_own_style_and_upper_layer_is_in_front(self):
        p = self.proj()
        p["subtitles"] = [
            {"id": "s1", "start": 1, "end": 4, "text": "아래 자막", "track": "S1", "clip_id": p["clips"][0]["id"], "words": []},
            {"id": "s3", "start": 1, "end": 4, "text": "위 자막", "track": "S3", "clip_id": p["clips"][0]["id"], "words": []},
        ]
        p["tracks"] = [dict(t, style={"position": "top", "color": "#FFFF00", "margin": 10.0}) if t["id"] == "S3" else t
                       for t in layers.default_tracks()]
        subs = export.output_subtitles(p)
        self.assertEqual(sorted(s["track"] for s in subs), ["S1", "S3"])          # 같은 시간에 겹쳐도 레이어가 다르면 모두 남는다
        styles = {tid: layers.subtitle_style(p, tid, p["style"]) for tid in ("S1", "S3")}
        order = {tid: layers.subtitle_layer(p, tid) for tid in ("S1", "S3")}
        ass = export.to_ass_layers(subs, styles, order, 320, 180)
        self.assertIn("Style: T_S1", ass)
        self.assertIn("Style: T_S3", ass)
        lines = [x for x in ass.splitlines() if x.startswith("Dialogue")]
        layer = {("S3" if "T_S3" in x else "S1"): int(x.split(",")[0].split(": ")[1]) for x in lines}
        self.assertGreater(layer["S3"], layer["S1"])
        style3 = next(x for x in ass.splitlines() if x.startswith("Style: T_S3"))
        self.assertIn("&H0000FFFF", style3)                                           # 노랑(BGR)
        self.assertIn(",8,", style3)                                                  # 상단 정렬
        # 숨긴 자막 레이어는 결과에서 빠진다
        p["tracks"] = [dict(t, hidden=True) if t["id"] == "S3" else t for t in p["tracks"]]
        self.assertEqual([s["track"] for s in export.output_subtitles(p)], ["S1"])

    def test_burned_layered_subtitles_render(self):
        p = self.proj()
        p["subtitles"] = [{"id": "s3", "start": 1, "end": 4, "text": "위쪽 자막 테스트", "track": "S3",
                           "clip_id": p["clips"][0]["id"], "words": []}]
        p["tracks"] = [dict(t, style={"position": "top", "color": "#00FF00", "size": 10.0}) if t["id"] == "S3" else t
                       for t in layers.default_tracks()]
        mp4 = self.dir / "l8.mp4"
        export.encode(p, mp4, burn=True)
        raw = media.run([media.ffmpeg(), "-v", "error", "-ss", "1.3", "-i", str(mp4), "-frames:v", "1",
                         "-vf", "scale=320:180", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout  # 1.3초는 빨강 구간
        def green(rows):
            n = 0
            for y in rows:
                for x in range(320):
                    r, g, b = raw[(y * 320 + x) * 3: (y * 320 + x) * 3 + 3]
                    n += 1 if (g > 180 and r < 90 and b < 90) else 0
            return n
        self.assertGreater(green(range(0, 70)), 20)       # 위쪽에 초록 글자
        self.assertEqual(green(range(110, 180)), 0)       # 아래쪽에는 없음


def p_clip_id(p):
    return p["clips"][0]["id"]


class AssetJobTest(unittest.TestCase):
    def test_upload_probe_preview_use_and_remove(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            png, wav, mp4 = root / "pic.png", root / "song.wav", root / "b.mp4"
            make_image(png)
            make_audio(wav, 440, 2.0)
            make_video(mp4, "green", 2.0)
            clip = root / "c.mp4"
            make_color_clip(clip)
            orig = (jobs.PROJECTS_DIR, jobs.OUTPUT_DIR)
            jobs.PROJECTS_DIR, jobs.OUTPUT_DIR = root / "p", root / "o"
            jobs.PROJECTS_DIR.mkdir()
            try:
                pid = jobs.create_project([("c.mp4", io.BytesIO(clip.read_bytes()))])["id"]
                built = project.build_project([clip], silence.SilenceParams())
                data = jobs.load(pid)
                built.update({"id": pid, "name": "t", "created": "x", "sources": data["sources"], "status": "ready"})
                jobs.save(pid, built)

                a_img = jobs.add_asset(pid, "pic.png", io.BytesIO(png.read_bytes()))
                a_wav = jobs.add_asset(pid, "song.wav", io.BytesIO(wav.read_bytes()))
                a_vid = jobs.add_asset(pid, "b.mp4", io.BytesIO(mp4.read_bytes()))
                self.assertEqual((a_img["kind"], a_img["width"], a_img["has_audio"]), ("image", 200, False))
                self.assertEqual((a_wav["kind"], round(a_wav["duration"]), a_wav["has_audio"]), ("audio", 2, True))
                self.assertEqual((a_vid["kind"], a_vid["has_audio"], a_vid["height"]), ("video", True, 180))
                for a in (a_img, a_wav, a_vid):
                    self.assertTrue(jobs.asset_preview_path(pid, a["id"]).is_file())
                with self.assertRaises(ValueError):
                    jobs.add_asset(pid, "notes.txt", io.BytesIO(b"x"))
                self.assertEqual(len(jobs.load(pid)["assets"]), 3)

                # 편집 저장으로 레이어에 올리고, 쓰는 동안은 지울 수 없다
                body = {"tracks": layers.default_tracks(),
                        "overlays": [{"id": "o1", "track": "V2", "type": "image", "src": a_img["id"], "start": 1, "dur": 3}],
                        "markers": [{"t": 2.5, "name": "중요"}]}
                saved = jobs.apply_edits(pid, body)
                self.assertEqual([o["id"] for o in saved["overlays"]], ["o1"])
                self.assertEqual(saved["markers"][0]["name"], "중요")
                with self.assertRaises(RuntimeError):
                    jobs.remove_asset(pid, a_img["id"])
                # 트랙 구성이 바뀌어 맞지 않는 항목은 저장 때 걸러진다
                saved = jobs.apply_edits(pid, {"tracks": [t for t in layers.default_tracks() if t["id"] != "V2"]})
                self.assertEqual(saved["overlays"], [])
                jobs.remove_asset(pid, a_img["id"])
                self.assertFalse(any(a["id"] == a_img["id"] for a in jobs.load(pid)["assets"]))
                with self.assertRaises(KeyError):
                    jobs.asset_preview_path(pid, a_img["id"])
                # 자막의 레이어(track)는 실제 자막 트랙일 때만 남는다
                subs = [{"id": "x", "start": 1, "end": 2, "text": "a", "track": "S3"},
                        {"id": "y", "start": 3, "end": 4, "text": "b", "track": "V1"}]
                saved = jobs.apply_edits(pid, {"subtitles": subs})
                self.assertEqual({s["id"]: s.get("track") for s in saved["subtitles"]}, {"x": "S3", "y": None})
                # 프로젝트를 지우면 자료 사본도 함께 사라진다
                jobs.delete_project(pid)
                self.assertFalse((jobs.PROJECTS_DIR / pid).exists())
            finally:
                jobs.PROJECTS_DIR, jobs.OUTPUT_DIR = orig


class LayerXmlTest(unittest.TestCase):
    def test_xml_has_extra_tracks_with_motion_opacity_and_levels(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            clip = root / "c.mp4"
            make_color_clip(clip)
            png, wav = root / "p.png", root / "m.wav"
            make_image(png)
            make_audio(wav)
            p = project.build_project([clip], silence.SilenceParams())
            p["cuts"] = []
            p["assets"] = [
                {"id": "img", "name": "p.png", "kind": "image", "path": str(png), "duration": 5.0, "width": 200, "height": 200, "has_audio": False},
                {"id": "mus", "name": "m.wav", "kind": "audio", "path": str(wav), "duration": 4.0, "width": 0, "height": 0, "has_audio": True},
            ]
            p["overlays"] = layers.clean_overlays([
                {"id": "i", "track": "V2", "type": "image", "src": "img", "start": 1, "dur": 2, "scale": 0.5, "opacity": 0.4, "x": 0.8, "y": 0.2},
                {"id": "m", "track": "A2", "type": "audio", "src": "mus", "start": 0, "volume": 0.5},
            ], p)
            pkg = root / "pkg"
            pkg.mkdir()
            media_map = export.prepare_media(p, pkg / "media", move=False)
            self.assertIn("asset:img", media_map)
            self.assertTrue(media_map["asset:img"].is_file())
            xml = export.write_xml(p, pkg, media_map).read_text(encoding="utf-8")
            root_el = ET.fromstring(xml.split("<!DOCTYPE xmeml>\n")[1])
            vtracks = root_el.findall("./sequence/media/video/track")
            self.assertEqual(len(vtracks), 2)                                    # V1 + V2
            item = vtracks[1].find("clipitem")
            self.assertEqual((item.find("start").text, item.find("end").text), ("30", "90"))
            self.assertIsNotNone(item.find(".//effect[name='Opacity']"))
            self.assertEqual(item.find(".//parameter[parameterid='opacity']/value").text, "40.0")
            self.assertIsNotNone(item.find(".//effect[name='Basic Motion']"))
            atracks = root_el.findall("./sequence/media/audio/track")
            self.assertEqual(len(atracks), 4)                                    # 메인 2 + 음악 2(좌/우)
            lvl = atracks[2].find(".//effect[name='Audio Levels']/parameter/value")
            self.assertEqual(lvl.text, "0.500")
            # 레이어 없는 프로젝트의 XML은 예전과 같은 트랙 수
            p2 = project.build_project([clip], silence.SilenceParams())
            p2["cuts"] = []
            m2 = export.prepare_media(p2, pkg / "media2", move=False)
            r2 = ET.fromstring(export.write_xml(p2, pkg, m2).read_text(encoding="utf-8").split("<!DOCTYPE xmeml>\n")[1])
            self.assertEqual(len(r2.findall("./sequence/media/video/track")), 1)
            self.assertEqual(len(r2.findall("./sequence/media/audio/track")), 2)


if __name__ == "__main__":
    unittest.main()
