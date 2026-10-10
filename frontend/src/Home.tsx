import { useEffect, useState } from "react";
import { api, uploadFiles, type ProjectSummary, type ReferenceResult } from "./api";
import { fmt } from "./time";

const STATUS: Record<ProjectSummary["status"], string> = {
  uploaded: "분석 전",
  analyzing: "분석 중",
  ready: "편집 가능",
  failed: "실패/중단",
  completed: "완료",
};

export default function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [upload, setUpload] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const [ref, setRef] = useState<ReferenceResult | null>(null);
  const [refBusy, setRefBusy] = useState(false);
  const [useRhythm, setUseRhythm] = useState(true);
  const [useStyle, setUseStyle] = useState(true);

  useEffect(() => {
    api.list().then(setProjects).catch((e) => setErr(e.message));
  }, []);

  const add = (list: FileList | null) => {
    if (!list) return;
    const picked = Array.from(list).filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name));
    if (picked.length < list.length) setErr("mp4 / mov / m4v 파일만 추가할 수 있습니다.");
    else setErr("");
    setFiles((prev) => [...prev, ...picked].sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true })));
  };

  const move = (i: number, d: number) =>
    setFiles((prev) => {
      const next = [...prev];
      const j = i + d;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const pickReference = async (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    if (!/\.(mp4|mov|m4v)$/i.test(f.name)) {
      setErr("레퍼런스도 mp4 / mov / m4v 파일만 가능합니다.");
      return;
    }
    setErr("");
    setRef(null);
    setRefBusy(true);
    try {
      const r = await api.analyzeReference(f);
      setRef(r);
      setUseRhythm(r.rhythm.ok);
      setUseStyle(r.subtitle.ok);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRefBusy(false);
    }
  };

  const start = async () => {
    setErr("");
    setUpload(0);
    try {
      const p = await uploadFiles(files, setUpload);
      const rhythm = ref && useRhythm && ref.rhythm.ok ? ref.rhythm.silence : undefined;
      const style = ref && useStyle && ref.subtitle.ok ? ref.subtitle.style : undefined;
      const parts = [rhythm && "편집 리듬", style && "자막 스타일"].filter(Boolean);
      const note = ref && parts.length
        ? { name: ref.name, rhythm_applied: !!rhythm, style_applied: !!style, summary: `${parts.join("·")} 적용` }
        : undefined;
      await api.start(
        p.id,
        p.sources.map((s) => s.sid),
        { threshold: "auto", min_silence: rhythm?.min_silence ?? 0.6, pad: rhythm?.pad ?? 0.15 },
        { style, reference: note },
      );
      onOpen(p.id);
    } catch (e) {
      setErr((e as Error).message);
      setUpload(null);
    }
  };

  const totalMB = files.reduce((a, f) => a + f.size, 0) / 1024 / 1024;
  const working = projects.filter((p) => p.status !== "completed");
  const done = projects.filter((p) => p.status === "completed").sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));

  return (
    <div className="home">
      <h1>영상 자동편집</h1>
      <p className="lead">무음 구간 자동 컷 + 자동 자막 → 타임라인에서 수정 → 내보내기. 모든 처리는 이 컴퓨터 안에서만 이뤄집니다.</p>

      <section className="card">
        <h2>새 프로젝트</h2>
        <label
          className={`drop ${over ? "over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
        >
          <input type="file" multiple accept=".mp4,.mov,.m4v,video/mp4,video/quicktime" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
          <span>영상 파일을 여기로 끌어오거나 <u>클릭해서 선택</u>하세요 (여러 개 가능)</span>
          <small>원본 파일은 수정되지 않습니다. 작업용 사본이 workspace 폴더에 저장됩니다.</small>
        </label>

        {files.length > 0 && (
          <>
            <h3>이어붙일 순서 ({files.length}개, {totalMB.toFixed(0)}MB)</h3>
            <ol className="files">
              {files.map((f, i) => (
                <li key={f.name + i}>
                  <span className="n">{i + 1}</span>
                  <span className="name">{f.name}</span>
                  <span className="size">{(f.size / 1024 / 1024).toFixed(1)}MB</span>
                  <button onClick={() => move(i, -1)} disabled={i === 0 || upload !== null} title="위로">▲</button>
                  <button onClick={() => move(i, 1)} disabled={i === files.length - 1 || upload !== null} title="아래로">▼</button>
                  <button onClick={() => setFiles(files.filter((_, j) => j !== i))} disabled={upload !== null} title="빼기">✕</button>
                </li>
              ))}
            </ol>
            <div className="ref-box">
              <h3>레퍼런스 영상 <small>(선택)</small></h3>
              <p className="hint">
                따라 하고 싶은 완성 영상을 올리면 말 사이 간격(편집 리듬)과 자막 위치·크기·색을 읽어 내 영상에 맞춥니다.
                레퍼런스는 분석만 하고 저장하지 않습니다.
              </p>
              <input type="file" accept=".mp4,.mov,.m4v,video/mp4,video/quicktime" disabled={refBusy || upload !== null}
                onChange={(e) => { pickReference(e.target.files); e.target.value = ""; }} />
              {refBusy && <p className="hint">레퍼런스를 분석하는 중입니다… (10분 영상 기준 약 30초)</p>}
              {ref && (
                <div className="ref-result">
                  <div className="ref-name">📎 {ref.name} <button onClick={() => setRef(null)} disabled={upload !== null}>빼기</button></div>
                  <label className="check format">
                    <input type="checkbox" checked={useRhythm && ref.rhythm.ok} disabled={!ref.rhythm.ok || upload !== null}
                      onChange={(e) => setUseRhythm(e.target.checked)} />
                    <span>
                      <b>편집 리듬 맞추기</b>
                      {ref.rhythm.ok ? (
                        <small>
                          {ref.rhythm.label} 템포 — 말 사이 간격 보통 {ref.rhythm.median_pause}초, 분당 {ref.rhythm.pauses_per_min}회.
                          {" "}→ {ref.rhythm.silence!.min_silence}초 이상 조용하면 컷, 말 앞뒤 {ref.rhythm.silence!.pad}초 남김
                        </small>
                      ) : <small>{ref.rhythm.note}</small>}
                    </span>
                  </label>
                  <label className="check format">
                    <input type="checkbox" checked={useStyle && ref.subtitle.ok} disabled={!ref.subtitle.ok || upload !== null}
                      onChange={(e) => setUseStyle(e.target.checked)} />
                    <span>
                      <b>자막 스타일 맞추기</b>
                      {ref.subtitle.ok ? (
                        <small>
                          {ref.subtitle.style!.position === "top" ? "상단" : "하단"} · 여백 {ref.subtitle.style!.margin}% · 크기 {ref.subtitle.style!.size}
                          {ref.subtitle.style!.color && (
                            <>
                              {" · 글자색 "}<i className="swatch" style={{ background: ref.subtitle.style!.color }} />
                              {" 외곽선 "}<i className="swatch" style={{ background: ref.subtitle.style!.outline_color }} />
                            </>
                          )}
                          {ref.subtitle.note && <em> {ref.subtitle.note}</em>}
                        </small>
                      ) : <small>{ref.subtitle.note}</small>}
                    </span>
                  </label>
                  <p className="hint">모두 추정값입니다. 분석이 끝난 뒤 편집 화면에서 자막 스타일과 컷을 고칠 수 있습니다. 글꼴은 읽지 못해 기본 글꼴을 씁니다.</p>
                </div>
              )}
            </div>
            {upload === null ? (
              <button className="primary big" onClick={start} disabled={refBusy}>업로드하고 분석 시작</button>
            ) : (
              <div className="progress"><div style={{ width: `${upload * 100}%` }} /><span>업로드 중 {Math.round(upload * 100)}%</span></div>
            )}
          </>
        )}
        {err && <div className="error">{err}</div>}
      </section>

      <section className="card">
        <h2>💾 작업 중 (임시저장)</h2>
        <p className="hint">편집 내용은 자동으로 저장됩니다. 클릭하면 이어서 작업할 수 있습니다.</p>
        {working.length === 0 ? (
          <p className="hint">작업 중인 프로젝트가 없습니다.</p>
        ) : (
          <table className="projects">
            <thead><tr><th>이름</th><th>클립</th><th>길이</th><th>상태</th><th>마지막 저장</th></tr></thead>
            <tbody>
              {working.map((p) => (
                <tr key={p.id} onClick={() => onOpen(p.id)}>
                  <td>{p.name}</td>
                  <td>{p.clips}개</td>
                  <td>{p.duration ? fmt(p.duration, 0) : "-"}</td>
                  <td><span className={`status ${p.status}`}>{STATUS[p.status]}</span></td>
                  <td>{(p.updated || p.created).replace("T", " ").slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>✔ 완료</h2>
        {done.length === 0 ? (
          <p className="hint">완료한 작업이 없습니다. 편집 화면에서 [✔ 완료]를 누르면 여기로 옮겨집니다.</p>
        ) : (
          <table className="projects">
            <thead><tr><th>이름</th><th>결과 길이</th><th>완료 일시</th></tr></thead>
            <tbody>
              {done.map((p) => (
                <tr key={p.id} onClick={() => onOpen(p.id)}>
                  <td>{p.name}</td>
                  <td>{p.duration ? fmt(p.duration, 0) : "-"}</td>
                  <td>{(p.completed || "").replace("T", " ").slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
