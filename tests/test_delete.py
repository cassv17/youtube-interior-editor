"""작업 중 프로젝트 삭제: 폴더 전체 삭제, 진행 중/완료 작업 보호, 일부 실패 시 목록에 남김."""
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend import jobs
from tests.test_silence import make_clip


class DeleteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self._orig = (jobs.PROJECTS_DIR, jobs.OUTPUT_DIR)
        jobs.PROJECTS_DIR, jobs.OUTPUT_DIR = root / "projects", root / "output"
        jobs.PROJECTS_DIR.mkdir()
        jobs.OUTPUT_DIR.mkdir()
        self.src = root / "a.mp4"
        make_clip(self.src)
        self.pid = jobs.create_project([(self.src.name, io.BytesIO(self.src.read_bytes()))])["id"]

    def tearDown(self):
        jobs.PROJECTS_DIR, jobs.OUTPUT_DIR = self._orig
        self.tmp.cleanup()

    def test_list_reports_size_and_delete_frees_it(self):
        row = next(r for r in jobs.list_projects() if r["id"] == self.pid)
        self.assertGreater(row["size"], self.src.stat().st_size * 0.9)
        (jobs.OUTPUT_DIR / "keep.txt").write_text("결과물", encoding="utf-8")
        freed = jobs.delete_project(self.pid)
        self.assertEqual(freed, row["size"])
        self.assertFalse((jobs.PROJECTS_DIR / self.pid).exists())
        self.assertEqual(jobs.list_projects(), [])
        self.assertTrue((jobs.OUTPUT_DIR / "keep.txt").is_file())  # 결과물은 그대로
        self.assertTrue(self.src.is_file())                        # 사용자 원본은 그대로

    def test_refuses_while_analyzing_or_export_running(self):
        data = jobs.load(self.pid)
        data["status"] = "analyzing"
        jobs.save(self.pid, data)
        jobs._status[self.pid] = {"stage": "분석 중"}
        with self.assertRaises(RuntimeError):
            jobs.delete_project(self.pid)
        jobs._status.pop(self.pid)
        data["status"] = "ready"
        jobs.save(self.pid, data)
        jobs._export_status[self.pid] = {"state": "running"}
        with self.assertRaises(RuntimeError):
            jobs.delete_project(self.pid)
        jobs._export_status.pop(self.pid)
        jobs._queue.put(("export", self.pid, {}))
        with self.assertRaises(RuntimeError):
            jobs.delete_project(self.pid)
        jobs._queue.get()
        self.assertTrue((jobs.PROJECTS_DIR / self.pid).exists())

    def test_completed_record_is_not_deletable(self):
        data = jobs.load(self.pid)
        data["status"] = "completed"
        jobs.save(self.pid, data)
        with self.assertRaises(ValueError):
            jobs.delete_project(self.pid)

    def test_partial_failure_keeps_project_visible(self):
        real = jobs.shutil.rmtree

        def flaky(path, *a, **k):
            if Path(path).name == "sources":
                raise PermissionError("사용 중")
            return real(path, *a, **k)

        with mock.patch.object(jobs.shutil, "rmtree", flaky):
            with self.assertRaises(OSError):
                jobs.delete_project(self.pid)
        self.assertEqual([r["id"] for r in jobs.list_projects()], [self.pid])  # 목록에 그대로 남음

    def test_unknown_or_path_like_id_is_rejected(self):
        for bad in ("nope", "..", "../x"):
            with self.assertRaises(KeyError):
                jobs.delete_project(bad)


if __name__ == "__main__":
    unittest.main()
