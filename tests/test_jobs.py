"""jobs.py 통합 테스트: 업로드 → 분석 → 순서변경(reproxy) → 완료(finalize)까지 실제로 돌려본다.

백그라운드 큐/스레드는 쓰지 않고 내부 함수(_run, _run_reproxy, _run_finalize)를 직접 호출해
동기적으로 검증한다. workspace/output 폴더는 임시 디렉터리로 바꿔치기해 실제 프로젝트 자료를
건드리지 않는다.
"""
import io
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from backend import jobs
from backend.core import silence
from tests.test_silence import make_clip


class JobsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.src_dir = root / "incoming"
        cls.src_dir.mkdir()
        cls.a = cls.src_dir / "클립A.mp4"
        cls.b = cls.src_dir / "클립B.mp4"
        make_clip(cls.a)
        make_clip(cls.b)

        # jobs 모듈의 저장 위치를 임시 폴더로 바꿔치기(실제 workspace/output 보호)
        cls._orig_projects_dir = jobs.PROJECTS_DIR
        cls._orig_output_dir = jobs.OUTPUT_DIR
        jobs.PROJECTS_DIR = root / "workspace_projects"
        jobs.OUTPUT_DIR = root / "output"
        jobs.PROJECTS_DIR.mkdir()

    @classmethod
    def tearDownClass(cls):
        jobs.PROJECTS_DIR = cls._orig_projects_dir
        jobs.OUTPUT_DIR = cls._orig_output_dir
        cls.tmp.cleanup()

    def upload(self) -> str:
        uploads = [(p.name, io.BytesIO(p.read_bytes())) for p in (self.a, self.b)]
        data = jobs.create_project(uploads)
        return data["id"]

    def analyze(self, pid: str) -> dict:
        jobs.start_analysis(pid, ["s1", "s2"], silence.SilenceParams())
        jobs._queue.get()  # start_analysis가 큐에 넣은 작업을 직접 꺼내 동기 실행
        jobs._run(pid)
        return jobs.load(pid)

    def test_full_pipeline(self):
        pid = self.upload()
        data = jobs.load(pid)
        self.assertEqual(data["status"], "uploaded")
        self.assertEqual(len(data["sources"]), 2)
        # 업로드는 원본과 다른 사본 파일이어야 한다
        self.assertNotEqual(Path(data["sources"][0]["path"]), self.a)
        self.assertTrue(Path(data["sources"][0]["path"]).is_file())

        data = self.analyze(pid)
        self.assertEqual(data["status"], "ready")
        self.assertEqual(len(data["clips"]), 2)
        self.assertTrue((jobs.project_dir(pid) / data["proxy"]).is_file())
        st = jobs.status(pid)  # 분석이 끝난 뒤에도 마지막 진행상황("완료")은 조회할 수 있어야 한다
        self.assertEqual(st["stage"], "완료")

        # ---- 순서 변경(그룹 없이): reorder는 프록시를 다시 만들도록 status를 analyzing으로 바꾼다 ----
        order = [data["clips"][1]["id"], data["clips"][0]["id"]]
        jobs.reorder(pid, order, [])
        kind, rpid, opts = jobs._queue.get()
        self.assertEqual((kind, rpid), ("reproxy", pid))
        old_proxy = jobs.load(pid)["proxy"]
        jobs._run_reproxy(pid)
        data = jobs.load(pid)
        self.assertEqual(data["status"], "ready")
        self.assertEqual([c["id"] for c in data["clips"]], order)
        self.assertNotEqual(data["proxy"], old_proxy)  # 새 미리보기 파일로 교체됨
        self.assertTrue((jobs.project_dir(pid) / data["proxy"]).is_file())
        self.assertFalse((jobs.project_dir(pid) / old_proxy).exists())  # 예전 파일은 지워짐

        # 그룹 지정 (두 클립을 붙여서 묶기)
        data = jobs.reorder(pid, order, [{"clips": order, "name": "테스트그룹"}])
        self.assertEqual(len(data["groups"]), 1)
        self.assertEqual(data["groups"][0]["clips"], order)
        self.assertNotIn(("reproxy", pid, {}), list(jobs._queue.queue))  # 순서 안 바뀌면 재생성 큐잉 안 됨

        # ---- 내보내기(작업 유지, 프리미어 포함): 원본 클립은 복사되고 작업은 계속된다 ----
        source_paths = [Path(c["path"]) for c in data["clips"]]
        jobs.start_export(pid, ["premiere"])
        kind, epid, eopts = jobs._queue.get()
        self.assertEqual((kind, epid), ("export", pid))
        jobs._run_export(pid, **eopts)
        after_export = jobs.load(pid)
        self.assertEqual(after_export["status"], "ready")  # 상태는 그대로
        for sp in source_paths:
            self.assertTrue(sp.is_file())  # 원본 클립이 그대로 남아 있다(복사만 함)
        self.assertEqual(len(after_export["exports"]), 1)
        export_result = after_export["exports"][0]
        self.assertTrue(any(f.endswith(".xml") for f in export_result["files"]))
        self.assertTrue(Path(export_result["folder"]).is_dir())

        # ---- 완료(finalize): 3가지 형식 모두 ----
        jobs.start_finalize(pid, ["burned", "clean", "premiere"])
        kind, fpid, fopts = jobs._queue.get()
        self.assertEqual((kind, fpid), ("finalize", pid))
        jobs._run_finalize(pid, **fopts)

        final = jobs.load(pid)
        self.assertEqual(final["status"], "completed")
        self.assertIn("completed", final)
        pkg = Path(final["folder"])
        self.assertTrue(pkg.is_dir())
        names = {Path(f).name for f in final["files"]}
        self.assertTrue(any(n.endswith("_자막입힘.mp4") for n in names))
        self.assertTrue(any(n.endswith(".srt") for n in names))
        self.assertTrue(any(n.endswith(".xml") for n in names))
        media_files = [f for f in final["files"] if "media" in Path(f).parts]
        self.assertEqual(len(media_files), 2)
        for f in media_files:
            self.assertTrue(Path(f).is_file())

        # XML이 실제로 media 폴더의 파일을 가리키는지
        xml_path = next(f for f in final["files"] if f.endswith(".xml"))
        root = ET.fromstring(Path(xml_path).read_text(encoding="utf-8"))
        urls = [e.text for e in root.iter("pathurl")]
        self.assertTrue(all("/media/" in u for u in urls))

        # 작업 기록(사본 포함)이 정리되어 project.json만 남아야 한다
        leftover = list(jobs.project_dir(pid).iterdir())
        self.assertEqual([p.name for p in leftover], ["project.json"])

        # 목록에서 완료로 표시되는지
        rows = {r["id"]: r for r in jobs.list_projects()}
        self.assertEqual(rows[pid]["status"], "completed")
        self.assertEqual(rows[pid]["clips"], 2)

        # 완료된 프로젝트는 더 이상 편집/재분석할 수 없어야 한다
        with self.assertRaises(RuntimeError):
            jobs.apply_edits(pid, {"cuts": []})
        with self.assertRaises(RuntimeError):
            jobs.start_finalize(pid, ["burned"])

    def test_download_path_traversal_blocked(self):
        jobs.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        inside = jobs.OUTPUT_DIR / "ok.txt"
        inside.write_text("x", encoding="utf-8")
        self.assertEqual(jobs.inside_output(inside), inside.resolve())
        with self.assertRaises(PermissionError):
            jobs.inside_output(jobs.OUTPUT_DIR.parent / "secret.txt")
        with self.assertRaises(PermissionError):
            jobs.inside_output(Path(jobs.OUTPUT_DIR) / ".." / "outside.txt")

    def test_finalize_requires_at_least_one_format(self):
        with self.assertRaises(ValueError):
            jobs.start_finalize("nonexistent", [])


if __name__ == "__main__":
    unittest.main()
