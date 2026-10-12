"""요청사항 해석: AI 답변 검증(범위·형식), AI 없는 환경, 분석 파이프라인 반영. 실제 AI는 부르지 않는다."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend import jobs
from backend.core import request_ai, silence
from tests.test_silence import make_clip


def reply(**kw) -> str:
    base = {"silence": None, "subtitle": None, "style": None, "speed_all": None, "terms": [], "unsupported": []}
    return "```json\n" + json.dumps({**base, **kw}, ensure_ascii=False) + "\n```"


class ParseTest(unittest.TestCase):
    def test_valid_reply_is_applied(self):
        r = request_ai.parse(reply(
            silence={"min_silence": 0.4, "pad": 0.08}, subtitle={"max_chars": 20},
            style={"position": "top", "margin": 8, "size": 6, "color": "#ffe000"},
            speed_all=1.2, terms=["히노끼", "아트월"], unsupported=["인트로 인사 빼줘"]))
        self.assertEqual(r["silence"], {"min_silence": 0.4, "pad": 0.08})
        self.assertEqual(r["subtitle"], {"max_chars": 20})
        self.assertEqual(r["style"], {"position": "top", "margin": 8.0, "size": 6.0, "color": "#FFE000"})
        self.assertEqual(r["speed_all"], 1.2)
        self.assertEqual(r["terms"], ["히노끼", "아트월"])
        self.assertEqual(r["unsupported"], ["인트로 인사 빼줘"])
        self.assertEqual(len(r["applied"]), 5)

    def test_out_of_range_values_are_clamped_and_junk_dropped(self):
        r = request_ai.parse(reply(
            silence={"min_silence": 99, "pad": -5}, subtitle={"max_chars": 1000},
            style={"position": "left", "margin": 500, "size": "abc", "color": "red", "outline_color": "#12345"},
            speed_all=50, terms=["", "x" * 80, "정상"]))
        self.assertEqual(r["silence"], {"min_silence": 2.0, "pad": 0.05})
        self.assertEqual(r["subtitle"], {"max_chars": 40})
        self.assertEqual(r["style"], {"margin": 20.0})
        self.assertEqual(r["speed_all"], 4.0)
        self.assertEqual(r["terms"], ["정상"])

    def test_short_min_silence_is_raised_to_keep_cuts(self):
        r = request_ai.parse(reply(silence={"min_silence": 0.3, "pad": 0.4}))
        self.assertEqual(r["silence"], {"min_silence": 1.0, "pad": 0.4})  # 2*pad+0.2

    def test_one_x_speed_and_empty_reply_do_nothing(self):
        r = request_ai.parse(reply(speed_all=1.0))
        self.assertIsNone(r["speed_all"])
        self.assertEqual(r["applied"], [])

    def test_unreadable_reply_raises(self):
        for bad in ("죄송합니다. 해석할 수 없습니다.", "{깨진 json", "[1, 2]"):
            with self.assertRaises(request_ai.RequestAIError):
                request_ai.parse(bad)

    def test_interpret_sends_only_the_request_text(self):
        sent = []
        r = request_ai.interpret("  말 사이 바짝 잘라줘  ", ask=lambda prompt: sent.append(prompt) or reply(
            silence={"min_silence": 0.35, "pad": 0.08}))
        self.assertTrue(sent[0].endswith("말 사이 바짝 잘라줘"))
        self.assertEqual(r["silence"]["pad"], 0.08)

    def test_interpret_rejects_empty_and_too_long(self):
        for text in ("   ", "가" * 2001):
            with self.assertRaises(request_ai.RequestAIError):
                request_ai.interpret(text, ask=lambda _p: reply())

    def test_without_claude_command_it_degrades(self):
        with mock.patch.object(request_ai, "claude_path", return_value=None):
            r = jobs.interpret_request("바짝 잘라줘")
        self.assertFalse(r["available"])
        self.assertIn("claude", r["note"])


class PipelineTest(unittest.TestCase):
    def test_request_settings_reach_the_project(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            a = td / "a.mp4"
            make_clip(a)
            orig = (jobs.PROJECTS_DIR, jobs.OUTPUT_DIR)
            jobs.PROJECTS_DIR, jobs.OUTPUT_DIR = td / "projects", td / "output"
            jobs.PROJECTS_DIR.mkdir()
            try:
                pid = jobs.create_project([(a.name, io.BytesIO(a.read_bytes()))])["id"]
                req = {"text": "바짝 잘라서 1.5배속, 자막은 상단", "silence": {"min_silence": 0.4, "pad": 0.1},
                       "style": {"position": "top"}, "speed_all": 1.5, "terms": ["히노끼"],
                       "unsupported": ["인트로 빼줘"], "evil": "x"}
                # 레퍼런스 스타일(하단)보다 요청(상단)이 우선해야 한다
                jobs.start_analysis(pid, ["s1"], silence.SilenceParams(min_silence=0.4, pad=0.1),
                                    style={"position": "bottom", "color": "#00FF00"}, request=req)
                jobs._queue.get()
                with mock.patch("backend.core.stt.transcribe_clip", return_value=[]) as tc:
                    jobs._run(pid)
                    self.assertEqual(tc.call_args.args[3], ("히노끼",))  # 용어가 음성인식 힌트로 전달됨
                data = jobs.load(pid)
            finally:
                jobs.PROJECTS_DIR, jobs.OUTPUT_DIR = orig
            self.assertEqual(data["style"]["position"], "top")
            self.assertEqual(data["style"]["color"], "#00FF00")
            self.assertEqual(data["speed_ranges"], [{"id": "speed-all", "start": 0.0, "end": data["duration"], "speed": 1.5}])
            self.assertEqual(data["request"]["unsupported"], ["인트로 빼줘"])
            self.assertEqual(data["request"]["text"], "바짝 잘라서 1.5배속, 자막은 상단")
            self.assertNotIn("evil", data["request"])


if __name__ == "__main__":
    unittest.main()
