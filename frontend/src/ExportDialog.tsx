import { useEffect, useState } from "react";
import { api, type ExportJob, type ExportResult, type FinishFormat } from "./api";
import { fmt } from "./time";

interface Props {
  mode: "export" | "finish"; // export: 작업 유지하고 결과만 뽑기 / finish: 최종 파일 + 작업 정리
  projectId: string;
  resultDuration: number;
  cutCount: number;
  subCount: number;
  reviewLeft: number;
  flush: () => Promise<void>; // 시작 전에 편집 내용을 먼저 저장
  onClose: () => void;
  onFinished: () => void;
}

export const FORMAT_INFO: Record<FinishFormat, { title: string; desc: string; icon: string }> = {
  burned: { icon: "🎬", title: "자막 입힌 영상", desc: "mp4 1개. 자막이 화면에 박혀 있어 바로 유튜브에 올릴 수 있습니다." },
  clean: { icon: "📝", title: "자막 없는 영상 + SRT 파일", desc: "유튜브에 자막을 따로 올리거나, 캡컷에서 영상을 불러온 뒤 자막만 SRT로 얹을 때" },
  premiere: { icon: "🎞️", title: "프리미어 · 다빈치용 (XML + 원본 클립)", desc: "XML(시퀀스) + 원본 클립 사본 + SRT. 프리미어에서 파일 > 가져오기로 열면 컷이 조각으로 나뉜 채 이어서 편집할 수 있습니다." },
};

export const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const isMedia = (f: string) => f.split(/[\\/]/).includes("media");

type Job = ExportJob & { result: ExportResult | null };

export default function ExportDialog(p: Props) {
  const finish = p.mode === "finish";
  const [formats, setFormats] = useState<FinishFormat[]>(["burned"]);
  const [agree, setAgree] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<ExportResult[]>([]);
  const [err, setErr] = useState("");
  const [started, setStarted] = useState(0); // 시작할 때마다 상태 확인을 다시 시작

  // 진행 중인 작업이 있으면 이어서 보여주고, 끝날 때까지 1초마다 확인한다
  useEffect(() => {
    let stop = false;
    let timer = 0;
    const poll = async () => {
      try {
        const pr = await api.get(p.projectId);
        if (stop) return;
        const j = (pr.export_job ?? null) as Job | null;
        setJob(j && (j.mode === "finalize") === finish ? j : null); // 다른 종류의 작업 상태는 무시
        setHistory(pr.exports ?? []);
        if (j?.state === "queued" || j?.state === "running") timer = window.setTimeout(poll, 1000);
      } catch (e) {
        setErr((e as Error).message);
      }
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [p.projectId, started, finish]);

  const toggle = (f: FinishFormat) =>
    setFormats((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));

  const start = async () => {
    setErr("");
    try {
      await p.flush();
      if (finish) await api.finalize(p.projectId, formats);
      else await api.export(p.projectId, formats);
      setJob({ state: "queued", progress: 0, result: null, error: "", mode: finish ? "finalize" : undefined });
      setStarted((n) => n + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const busy = job?.state === "queued" || job?.state === "running";
  const done = job?.state === "done" && job.result;
  const encodes = formats.filter((f) => f !== "premiere").length;

  const resultPanel = (result: ExportResult, heading: string) => (
    <div className="done">
      {heading}
      <div className="folder">📁 {fileName(result.folder)}</div>
      <ul className="files">
        {result.files.filter((f) => !isMedia(f)).map((f) => (
          <li key={f}><a href={api.downloadUrl(f)} download>⬇ {fileName(f)}</a></li>
        ))}
      </ul>
      {result.files.some(isMedia) && (
        <p className="hint">
          프리미어·다빈치용 원본 클립은 위 폴더 안의 <b>media</b> 폴더에 함께 있습니다. XML이 이 파일들을 상대 위치로 가리키므로, 옮길 때는 폴더째로 옮기세요.
        </p>
      )}
    </div>
  );

  return (
    <div className="modal-bg" onClick={() => !busy && !done && p.onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{finish ? "✔ 완료하기" : "내보내기 (작업은 그대로 유지)"}</h2>
        <dl className="stats">
          <dt>결과 길이</dt><dd><b>{fmt(p.resultDuration)}</b></dd>
          <dt>적용 컷</dt><dd>{p.cutCount}개</dd>
          <dt>자막</dt><dd>{p.subCount}개</dd>
        </dl>
        {p.reviewLeft > 0 && !done && (
          <div className="reasons">⚠ 아직 확인하지 않은 항목이 {p.reviewLeft}개 있습니다. 그대로 진행해도 되지만, 편집 탭의 '확인 필요' 목록을 한 번 보시길 권합니다.</div>
        )}

        {!done && (
          <>
            <h4>내려받을 형식 (여러 개 선택 가능)</h4>
            {(Object.keys(FORMAT_INFO) as FinishFormat[]).map((f) => (
              <label key={f} className="check format">
                <input type="checkbox" checked={formats.includes(f)} disabled={busy} onChange={() => toggle(f)} />
                <span><b>{FORMAT_INFO[f].icon} {FORMAT_INFO[f].title}</b><small>{FORMAT_INFO[f].desc}</small></span>
              </label>
            ))}
            <p className="hint">
              {encodes > 0
                ? `영상이 필요한 형식 ${encodes}개를 인코딩합니다(10분 영상 기준 개당 약 3~12분). `
                : ""}
              {formats.includes("premiere") ? "프리미어용은 인코딩 없이 바로 만들어집니다(원본 클립을 그대로 복사)." : ""}
              {" "}원본 파일은 바뀌지 않습니다.
            </p>
            {finish && (
              <div className="reasons danger-box">
                <label className="check">
                  <input type="checkbox" checked={agree} disabled={busy} onChange={(e) => setAgree(e.target.checked)} />
                  완료하면 이 작업의 편집 기록과 업로드 사본이 삭제되어 <b>다시 수정할 수 없습니다.</b> 결과 파일은 output 폴더에 남고, 첫 화면 '완료' 목록에서 내려받을 수 있습니다.
                </label>
              </div>
            )}
          </>
        )}

        {busy && (
          <div className="progress">
            <div style={{ width: `${(job!.progress || 0) * 100}%` }} />
            <span>{job!.state === "queued" ? "대기 중 (다른 작업이 끝나면 시작)" : `만드는 중 ${Math.round((job!.progress || 0) * 100)}%`}</span>
          </div>
        )}
        {job?.state === "failed" && (
          <div className="error">
            실패: {job.error}
            {finish ? "\n작업 기록은 지워지지 않았습니다. 다시 시도할 수 있습니다." : ""}
          </div>
        )}

        {done && resultPanel(job.result!, finish ? "✅ 완료되었습니다. 파일은 아래 폴더에 있습니다." : "✅ 내보내기 완료 (output 폴더)")}
        {err && <div className="error">{err}</div>}

        <div className="row end">
          <button onClick={() => api.openOutput(done ? job!.result!.folder : undefined).catch((e) => setErr(e.message))}>📂 폴더 열기</button>
          <div className="spacer" />
          {done && finish ? (
            <button className="primary" onClick={p.onFinished}>완료 목록으로</button>
          ) : (
            <>
              <button onClick={p.onClose} disabled={busy}>닫기</button>
              <button className="primary" onClick={start} disabled={busy || formats.length === 0 || (finish && !agree)}>
                {finish ? "완료하고 파일 만들기" : done ? "다시 내보내기" : "내보내기 시작"}
              </button>
            </>
          )}
        </div>

        {!finish && history.length > 0 && (
          <>
            <h4>이전 결과</h4>
            <ul className="exports">
              {[...history].reverse().map((r, i) => {
                // 예전 버전(폴더 없이 mp4/srt만 있던 시절)의 기록도 깨지지 않게 표시한다
                const legacy = r as unknown as { mp4?: string; srt?: string | null; burned?: boolean };
                const label = r.folder ? fileName(r.folder) : legacy.mp4 ? fileName(legacy.mp4) : "결과";
                const meta = r.formats
                  ? r.formats.map((f) => FORMAT_INFO[f]?.title ?? f).join(" · ")
                  : `${legacy.burned ? "자막 입힘" : "자막 없음"}${legacy.srt ? " · srt" : ""}`;
                return (
                  <li key={r.folder ?? legacy.mp4 ?? i}>
                    <span>{r.created.replace("T", " ").slice(5, 16)}</span>
                    <span className="name">{label}</span>
                    <span className="meta">{meta}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
