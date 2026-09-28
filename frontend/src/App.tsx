import { useEffect, useState } from "react";
import { api, type Project } from "./api";
import Editor from "./Editor";
import { FORMAT_INFO, fileName } from "./ExportDialog";
import Home from "./Home";

/** 주소 뒤 #/p/<id> 로 프로젝트를 연다(새로고침해도 그대로). */
function useRoute() {
  const read = () => window.location.hash.match(/^#\/p\/([\w-]+)/)?.[1] ?? null;
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [id, (next: string | null) => (window.location.hash = next ? `#/p/${next}` : "#/")] as const;
}

export default function App() {
  const [id, go] = useRoute();
  return id ? <ProjectPage key={id} id={id} onBack={() => go(null)} /> : <Home onOpen={go} />;
}

function ProjectPage({ id, onBack }: { id: string; onBack: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [err, setErr] = useState("");
  const [attempt, setAttempt] = useState(0);

  // 분석이 끝날 때까지 1초마다 상태를 확인한다
  useEffect(() => {
    let stop = false;
    let timer = 0;
    const poll = async () => {
      try {
        const p = await api.get(id);
        if (stop) return;
        setProject(p);
        if (p.status === "analyzing") timer = window.setTimeout(poll, 1000);
      } catch (e) {
        if (!stop) setErr((e as Error).message);
      }
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id, attempt]);

  if (err) return <Message onBack={onBack}><div className="error">{err}</div></Message>;
  if (!project) return <Message onBack={onBack}>불러오는 중…</Message>;
  if (project.status === "ready")
    return <Editor project={project} onBack={onBack} onReload={() => setAttempt((n) => n + 1)} onFinished={onBack} />;
  if (project.status === "completed") return <Completed project={project} onBack={onBack} />;

  const restart = async () => {
    const order = project.order ?? project.sources.map((s) => s.sid);
    try {
      await api.start(project.id, order, { threshold: "auto", min_silence: 0.6, pad: 0.15 });
      setAttempt((n) => n + 1); // 상태 확인을 다시 시작
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const reproxy = async () => {
    try {
      await api.reproxy(project.id);
      setAttempt((n) => n + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const job = project.job;
  return (
    <Message onBack={onBack}>
      <h2>{project.name}</h2>
      {project.status === "analyzing" && (
        <>
          <p>{job?.stage ?? "대기 중"} {job?.detail ? `— ${job.detail}` : ""}</p>
          <div className="progress"><div style={{ width: `${(job?.progress ?? 0) * 100}%` }} /><span>{Math.round((job?.progress ?? 0) * 100)}%</span></div>
          <p className="hint">
            {job?.stage?.includes("순서") || job?.detail?.includes("순서")
              ? "클립 순서가 바뀌어 미리보기 영상을 다시 만들고 있습니다(10분 영상 약 1분). 끝나면 편집 화면으로 돌아갑니다."
              : "순서: 무음 구간 분석 → 미리보기 영상 → 음성인식(가장 오래 걸림, 10분 영상 약 4~5분). 이 창을 닫아도 분석은 계속됩니다."}
          </p>
        </>
      )}
      {project.status === "failed" && (
        <>
          <div className="error">{project.error || "분석에 실패했습니다."}</div>
          {project.clips?.length ? (
            <>
              <p className="hint">편집하던 내용(컷·자막·순서)은 그대로 남아 있습니다. 미리보기 영상만 다시 만들면 이어서 작업할 수 있습니다.</p>
              <div className="row">
                <button className="primary" onClick={reproxy}>미리보기만 다시 만들기 (편집 내용 유지)</button>
                <button className="danger" onClick={() => confirm("처음부터 다시 분석하면 지금까지 편집한 컷·자막이 모두 사라집니다. 계속할까요?") && restart()}>처음부터 다시 분석</button>
              </div>
            </>
          ) : (
            <button className="primary" onClick={restart}>다시 분석</button>
          )}
        </>
      )}
      {project.status === "uploaded" && <button className="primary" onClick={restart}>분석 시작</button>}
    </Message>
  );
}

function Message({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  return (
    <div className="home">
      <button className="link" onClick={onBack}>← 프로젝트 목록</button>
      <section className="card">{children}</section>
    </div>
  );
}

/** 완료된 작업: 편집 기록은 지워졌고 결과 파일만 남아 있다. */
function Completed({ project, onBack }: { project: Project; onBack: () => void }) {
  const [err, setErr] = useState("");
  const isMedia = (f: string) => f.split(/[\\/]/).includes("media");
  const files = (project.files ?? []).filter((f) => !isMedia(f));
  const media = (project.files ?? []).filter((f) => isMedia(f));
  return (
    <Message onBack={onBack}>
      <h2>✔ {project.name}</h2>
      <dl className="stats">
        <dt>완료</dt><dd>{project.completed?.replace("T", " ").slice(0, 16)}</dd>
        <dt>결과 길이</dt><dd>{project.duration ? `${Math.floor(project.duration / 60)}분 ${Math.round(project.duration % 60)}초` : "-"}</dd>
        <dt>형식</dt><dd>{(project.formats ?? []).map((f) => FORMAT_INFO[f]?.title ?? f).join(", ")}</dd>
      </dl>
      <h4>내려받기</h4>
      <ul className="files">
        {files.map((f) => (
          <li key={f}><a href={api.downloadUrl(f)} download>⬇ {fileName(f)}</a></li>
        ))}
      </ul>
      {media.length > 0 && (
        <p className="hint">
          프리미어·다빈치용 원본 클립 {media.length}개는 결과 폴더의 media 폴더에 있습니다. XML이 이 파일들을 가리키므로 폴더째로 옮기세요.
        </p>
      )}
      <button onClick={() => api.openOutput(project.folder).catch((e) => setErr(e.message))}>📂 결과 폴더 열기</button>
      {err && <div className="error">{err}</div>}
      <p className="hint">완료된 작업은 편집 기록이 삭제되어 다시 수정할 수 없습니다.</p>
    </Message>
  );
}
