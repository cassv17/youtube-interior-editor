import { useEffect, useState } from "react";
import { api, uploadFiles, type ProjectSummary, type ReferenceResult, type RequestPayload, type RequestResult } from "./api";
import { fmt } from "./time";

const STATUS: Record<ProjectSummary["status"], string> = {
  uploaded: "분석 전",
  analyzing: "분석 중",
  ready: "편집 가능",
  failed: "실패/중단",
  completed: "완료",
};

const EXAMPLES = [
  { label: "목적·길이", text: "유튜브 롱폼 10분 이내, 시공 전후 비교가 핵심인 영상이야." },
  { label: "컷 강도", text: "말 사이 쉬는 구간은 바짝 자르고 템포 빠르게 편집해줘." },
  { label: "자막 스타일", text: "자막은 화면 위쪽에 노란색으로, 한 줄 20자 이내로 해줘." },
  { label: "용어 표기", text: "'히노끼', '아트월', '간접조명'은 정확히 표기해줘." },
  { label: "전체 배속", text: "전체를 1.2배속으로 해줘." },
];

const sizeText = (b?: number) => {
  if (b === undefined) return "-";
  return b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)}GB` : `${Math.max(1, Math.round(b / 1024 ** 2))}MB`;
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
  const [reqText, setReqText] = useState("");
  const [reqResult, setReqResult] = useState<RequestResult | null>(null);
  const [reqBusy, setReqBusy] = useState(false);
  const [reqUse, setReqUse] = useState(true);

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

  const editReq = (text: string) => {
    setReqText(text);
    setReqResult(null); // 글이 바뀌면 이전 해석 결과는 더 이상 맞지 않는다
  };

  const interpret = async (): Promise<RequestResult | null> => {
    setErr("");
    setReqBusy(true);
    try {
      const r = await api.interpretRequest(reqText);
      setReqResult(r);
      setReqUse(true);
      return r;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setReqBusy(false);
    }
  };

  const start = async () => {
    setErr("");
    let req = reqResult;
    if (reqText.trim() && !req) {
      req = await interpret(); // 해석 결과를 아직 안 봤으면 시작 전에 해석한다
      if (!req) return;
    }
    setUpload(0);
    try {
      const p = await uploadFiles(files, setUpload);
      const rhythm = ref && useRhythm && ref.rhythm.ok ? ref.rhythm.silence : undefined;
      const style = ref && useStyle && ref.subtitle.ok ? ref.subtitle.style : undefined;
      const useReq = !!(req && req.available && reqUse);
      const request: RequestPayload | undefined = reqText.trim()
        ? {
            text: reqText.trim(),
            ...(useReq
              ? { silence: req!.silence, subtitle: req!.subtitle, style: req!.style, speed_all: req!.speed_all, terms: req!.terms, unsupported: req!.unsupported }
              : {}),
          }
        : undefined;
      const sil = (useReq && req!.silence) || rhythm;
      const parts = [rhythm && "편집 리듬", style && "자막 스타일"].filter(Boolean);
      const note = ref && parts.length
        ? { name: ref.name, rhythm_applied: !!rhythm, style_applied: !!style, summary: `${parts.join("·")} 적용` }
        : undefined;
      await api.start(
        p.id,
        p.sources.map((s) => s.sid),
        { threshold: "auto", min_silence: sil?.min_silence ?? 0.6, pad: sil?.pad ?? 0.15 },
        { style, reference: note, request },
      );
      onOpen(p.id);
    } catch (e) {
      setErr((e as Error).message);
      setUpload(null);
    }
  };

  const removeProject = async (p: ProjectSummary) => {
    const busy = p.status === "analyzing";
    if (busy) {
      setErr("분석 중인 작업은 지울 수 없습니다. 끝난 뒤에 다시 시도해 주세요.");
      return;
    }
    if (!confirm(`'${p.name}' 작업을 삭제할까요?

편집 내용과 업로드 사본(${sizeText(p.size)})이 지워지며 되돌릴 수 없습니다.
내 원본 영상과, 이미 내보낸 결과 파일(output 폴더)은 그대로 남습니다.`)) return;
    try {
      await api.remove(p.id);
      setProjects((prev) => prev.filter((x) => x.id !== p.id));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
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

        <div className="req-box">
          <h3>편집 요청사항 <small className="hint">(선택)</small></h3>
          <p className="hint">
            원하는 편집 방향을 적으면 자동 초안을 그에 맞춰 만듭니다. AI에는 <b>이 요청 글만</b> 전달되고, 영상·음성·자막 내용은 전달되지 않습니다.
          </p>
          <div className="chips">
            {EXAMPLES.map((ex) => (
              <button key={ex.label} className="chip" disabled={upload !== null || reqBusy}
                onClick={() => editReq(reqText.includes(ex.text) ? reqText : (reqText ? reqText + "\n" : "") + ex.text)}
                title={ex.text}>
                <b>＋</b>{ex.label}
              </button>
            ))}
          </div>
          <textarea
            value={reqText}
            maxLength={2000}
            disabled={upload !== null || reqBusy}
            placeholder={"예) 유튜브 롱폼 10분 이내, 시공 전후 비교가 핵심이야.\n말 사이 쉬는 구간은 바짝 자르고, 자막은 위쪽에 노란색으로 한 줄 20자 이내로 해줘.\n'히노끼', '아트월'은 정확히 표기해줘."}
            onChange={(e) => editReq(e.target.value)}
          />
          <div className="req-count">{reqText.length} / 2000자</div>
          <p className="hint">
            ※ <b>무엇을</b>(컷 강도·자막 위치/색/글자 수·전체 배속·자주 쓰는 용어)을 구체적으로 적을수록 잘 맞습니다.
            "인트로 인사 빼줘", "이 장면만 1.5배속"처럼 <b>영상 내용이나 특정 구간</b>을 가리키는 요청은 자동으로 적용되지 않습니다. 편집 화면 타임라인에서 직접 컷·배속 구간을 지정해 주세요.
          </p>
          <div className="row">
            <button onClick={() => interpret()} disabled={!reqText.trim() || reqBusy || upload !== null}>
              {reqBusy ? "요청을 해석하는 중… (약 30초)" : "요청 반영 확인"}
            </button>
          </div>
          {reqResult && (
            <div className="req-result">
              {!reqResult.available ? (
                <p className="hint">{reqResult.note}</p>
              ) : (
                <>
                  <b>적용되는 설정</b>
                  {reqResult.applied.length ? (
                    <ul>{reqResult.applied.map((a) => <li key={a}>{a}</li>)}</ul>
                  ) : (
                    <p className="none">자동으로 적용할 수 있는 설정을 찾지 못했습니다.</p>
                  )}
                  {reqResult.unsupported.length > 0 && (
                    <>
                      <b>자동 적용하지 못하는 요청 (편집 화면에서 직접 해 주세요)</b>
                      <ul>{reqResult.unsupported.map((a) => <li key={a}>{a}</li>)}</ul>
                    </>
                  )}
                  <label className="check">
                    <input type="checkbox" checked={reqUse} disabled={upload !== null} onChange={(e) => setReqUse(e.target.checked)} />
                    이 설정으로 분석하기 (레퍼런스와 겹치면 요청사항이 우선)
                  </label>
                </>
              )}
            </div>
          )}
        </div>

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
        <p className="hint">
          편집 내용은 자동으로 저장됩니다. 클릭하면 이어서 작업할 수 있습니다. 작업마다 업로드한 영상의 사본과 미리보기를 보관하므로 용량을 차지합니다(합계 {sizeText(working.reduce((a, p) => a + (p.size ?? 0), 0))}). 필요 없는 작업은 삭제해 용량을 비우세요.
        </p>
        {working.length === 0 ? (
          <p className="hint">작업 중인 프로젝트가 없습니다.</p>
        ) : (
          <table className="projects">
            <thead><tr><th>이름</th><th>클립</th><th>길이</th><th>상태</th><th>용량</th><th>마지막 저장</th><th></th></tr></thead>
            <tbody>
              {working.map((p) => (
                <tr key={p.id} onClick={() => onOpen(p.id)}>
                  <td>{p.name}</td>
                  <td>{p.clips}개</td>
                  <td>{p.duration ? fmt(p.duration, 0) : "-"}</td>
                  <td><span className={`status ${p.status}`}>{STATUS[p.status]}</span></td>
                  <td>{sizeText(p.size)}</td>
                  <td>{(p.updated || p.created).replace("T", " ").slice(0, 16)}</td>
                  <td>
                    <button className="danger" title="이 작업과 업로드 사본을 삭제합니다"
                      onClick={(e) => { e.stopPropagation(); removeProject(p); }}>🗑 삭제</button>
                  </td>
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
