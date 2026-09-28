"""음성인식 단어 기준 컷 보정 검증 (영상 없이 순수 계산만)."""
import unittest

from backend.core import cuts


def make_project(cut_list, words):
    return {
        "silence_params": {"pad": 0.15, "min_cut": 0.2},
        "clips": [{"id": "c1", "offset": 0.0, "duration": 10.0, "has_audio": True},
                  {"id": "c2", "offset": 10.0, "duration": 5.0, "has_audio": True}],
        "cuts": [{"id": f"x{i}", "clip_id": cl, "start": s, "end": e, "origin": "silence",
                  "enabled": True, "mean_db": -40, "needs_review": False, "review_reasons": []}
                 for i, (cl, s, e) in enumerate(cut_list)],
        "subtitles": [{"clip_id": cl, "words": [{"w": "말", "s": s, "e": e, "p": 0.9}]}
                      for cl, s, e in words],
    }


def spans(project, enabled=True):
    return [(c["start"], c["end"]) for c in project["cuts"] if c["enabled"] == enabled]


class RefineTest(unittest.TestCase):
    def test_word_inside_cut_splits_it(self):
        p = make_project([("c1", 1.0, 4.0)], [("c1", 2.0, 2.5), ("c1", 0.0, 0.8), ("c1", 4.5, 9.5)])
        cuts.refine_with_words(p)
        self.assertEqual(spans(p), [(1.0, 1.85), (2.65, 4.0)])
        self.assertTrue(all(c["needs_review"] for c in p["cuts"] if c["enabled"]))

    def test_cut_fully_covered_by_speech_is_removed(self):
        p = make_project([("c1", 1.0, 1.5)], [("c1", 0.0, 9.9)])
        cuts.refine_with_words(p)
        self.assertEqual(spans(p), [])

    def test_untouched_cut_has_no_review_flag(self):
        p = make_project([("c1", 3.0, 4.0)], [("c1", 0.0, 2.0), ("c1", 5.0, 10.0)])
        cuts.refine_with_words(p)
        self.assertEqual(spans(p), [(3.0, 4.0)])
        self.assertFalse(p["cuts"][0]["needs_review"])

    def test_long_gap_without_speech_becomes_disabled_proposal(self):
        # c1: 말 0~2, 6~10 → 2.15~5.85 사이 컷이 없으면 꺼진 제안 컷
        p = make_project([], [("c1", 0.0, 2.0), ("c1", 6.0, 10.0), ("c2", 10.0, 15.0)])
        stats = cuts.refine_with_words(p)
        self.assertEqual(spans(p, enabled=False), [(2.15, 5.85)])
        self.assertEqual(stats["proposed"], 1)
        self.assertEqual(p["cuts"][0]["origin"], "no-speech")

    def test_rerun_is_stable(self):
        p = make_project([("c1", 1.0, 4.0)], [("c1", 2.0, 2.5), ("c1", 0.0, 0.8), ("c1", 4.5, 9.5)])
        cuts.refine_with_words(p)
        first = [(c["start"], c["end"], c["enabled"], c["review_reasons"]) for c in p["cuts"]]
        cuts.refine_with_words(p)
        second = [(c["start"], c["end"], c["enabled"], c["review_reasons"]) for c in p["cuts"]]
        self.assertEqual(first, second)

    def test_user_cut_is_kept_as_is(self):
        p = make_project([], [("c1", 0.0, 10.0)])
        p["cuts"].append({"id": "u", "clip_id": "c1", "start": 3.0, "end": 4.0, "origin": "user",
                          "enabled": True, "needs_review": False, "review_reasons": []})
        cuts.refine_with_words(p)
        self.assertEqual(spans(p), [(3.0, 4.0)])


if __name__ == "__main__":
    unittest.main()
