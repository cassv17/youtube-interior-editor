import { useState } from "react";
import type { ClipAnalysis, Clip, Cut, SilenceParams, Style, Subtitle } from "./api";
import type { Selection } from "./Timeline";
import { fmt, snap } from "./time";

export interface EditDoc {
  cuts: Cut[];
  subtitles: Subtitle[];
  style: Style;
}

interface Props {
  doc: EditDoc;
  duration: number;
  resultDuration: number;
  clips: Clip[];
  analysis: Record<string, ClipAnalysis>;
  silence: SilenceParams;
  selection: Selection;
  time: number;
  update: (fn: (d: EditDoc) => EditDoc, record?: boolean) => void;
  begin: () => void;
  end: () => void;
  onSelect: (s: Selection) => void;
  onPlayFrom: (t: number) => void;
  onAddCut: () => void;
  onAddSub: () => void;
  onRedetect: (p: SilenceParams) => Promise<void>;
}

type Tab = "edit" | "silence" | "style";

export default function Inspector(p: Props) {
  const [tab, setTab] = useState<Tab>("edit");
  return (
    <aside className="inspector">
      <nav className="tabs">
        <button className={tab === "edit" ? "on" : ""} onClick={() => setTab("edit")}>편집</button>
        <button className={tab === "silence" ? "on" : ""} onClick={() => setTab("silence")}>무음 설정</button>
        <button className={tab === "style" ? "on" : ""} onClick={() => setTab("style")}>자막 스타일</button>
      </nav>
      <div className="panel">
        {tab === "edit" && <EditTab {...p} />}
        {tab === "silence" && <SilenceTab {...p} />}
        {tab === "style" && <StyleTab {...p} />}
      </div>
    </aside>
  );
}

// ---------------- 편집 탭 ----------------

function EditTab(p: Props) {
  const sel = p.selection;
  if (sel?.kind === "sub") {
    const s = p.doc.subtitles.find((x) => x.id === sel.id);
    if (s) return <SubEditor {...p} sub={s} />;
  }
  if (sel?.kind === "cut") {
    const c = p.doc.cuts.find((x) => x.id === sel.id);
    if (c) return <CutEditor {...p} cut={c} />;
  }
  return <Overview {...p} />;
}

function Overview(p: Props) {
  const reviewCuts = p.doc.cuts.filter((c) => c.needs_review);
  const reviewSubs = p.doc.subtitles.filter((s) => s.needs_review);
  const items = [
    ...reviewCuts.map((c) => ({ kind: "cut" as const, id: c.id, t: c.start, label: c.enabled ? "컷" : "제안 컷", text: c.review_reasons.join(" / ") })),
    ...reviewSubs.map((s) => ({ kind: "sub" as const, id: s.id, t: s.start, label: "자막", text: `"${s.text}" — ${s.review_reasons.join(" / ")}` })),
  ].sort((a, b) => a.t - b.t);
  const enabled = p.doc.cuts.filter((c) => c.enabled).length;
  const proposals = p.doc.cuts.length - enabled;
  return (
    <div className="overview">
      <dl className="stats">
        <dt>원본 길이</dt><dd>{fmt(p.duration)}</dd>
        <dt>컷 적용 후</dt><dd><b>{fmt(p.resultDuration)}</b></dd>
        <dt>적용 컷</dt><dd>{enabled}개{proposals ? ` (꺼진 제안 ${proposals}개)` : ""}</dd>
        <dt>자막</dt><dd>{p.doc.subtitles.length}개</dd>
      </dl>
      <div className="row">
        <button onClick={p.onAddCut}>＋ 현재 위치에 컷</button>
        <button onClick={p.onAddSub}>＋ 현재 위치에 자막</button>
      </div>
      <h4>확인 필요 {items.length}개</h4>
      <p className="hint">자동 판단이 불확실한 곳입니다. 클릭하면 그 위치로 이동합니다. 표시가 없는 자막도 오인식이 있을 수 있으니 한 번씩 훑어보세요.</p>
      <ul className="review-list">
        {items.map((it) => (
          <li key={it.id} onClick={() => { p.onSelect({ kind: it.kind, id: it.id }); p.onPlayFrom(Math.max(0, it.t - 1)); }}>
            <span className="t">{fmt(it.t)}</span>
            <span className={`k k-${it.kind}`}>{it.label}</span>
            <span className="x">{it.text}</span>
          </li>
        ))}
      </ul>
      <h4>단축키</h4>
      <p className="hint">
        Space 재생/정지 · Delete 선택 항목 삭제 · Ctrl+Z 되돌리기 · Ctrl+Shift+Z 다시하기 · ←/→ 1초 이동 · Ctrl+휠 타임라인 확대
      </p>
    </div>
  );
}

function TimeFields(props: { start: number; end: number; min: number; max: number; onChange: (s: number, e: number) => void }) {
  const set = (which: "s" | "e", v: string) => {
    const n = snap(parseFloat(v));
    if (!isFinite(n)) return;
    const s = which === "s" ? Math.min(Math.max(n, props.min), props.end - 1 / 30) : props.start;
    const e = which === "e" ? Math.max(Math.min(n, props.max), props.start + 1 / 30) : props.end;
    props.onChange(s, e);
  };
  return (
    <div className="time-fields">
      <label>시작(초)<NumField value={props.start} onCommit={(v) => set("s", v)} /></label>
      <label>끝(초)<NumField value={props.end} onCommit={(v) => set("e", v)} /></label>
      <span className="len">{(props.end - props.start).toFixed(2)}초</span>
    </div>
  );
}

/** 입력 중에는 그대로 두고, Enter나 포커스 이동 시에 반영한다. */
function NumField({ value, onCommit }: { value: number; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      type="number"
      step={0.1}
      value={draft ?? value.toFixed(2)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function Reasons({ reasons, onResolve }: { reasons: string[]; onResolve: () => void }) {
  if (!reasons.length) return null;
  return (
    <div className="reasons">
      {reasons.map((r, i) => <div key={i}>⚠ {r}</div>)}
      <button onClick={onResolve}>확인 완료 (표시 지우기)</button>
    </div>
  );
}

function SubEditor(p: Props & { sub: Subtitle }) {
  const s = p.sub;
  const others = p.doc.subtitles.filter((x) => x.id !== s.id);
  const prevEnd = Math.max(0, ...others.filter((x) => x.end <= s.start + 1e-6).map((x) => x.end));
  const nextStart = Math.min(p.duration, ...others.filter((x) => x.start >= s.end - 1e-6).map((x) => x.start));
  const patch = (fn: (x: Subtitle) => Subtitle, record = true) =>
    p.update((d) => ({ ...d, subtitles: d.subtitles.map((x) => (x.id === s.id ? fn(x) : x)) }), record);
  const original = s.words.map((w) => w.w).join("").trim();
  return (
    <div className="editor">
      <h3>자막 <small>{fmt(s.start, 2)} ~ {fmt(s.end, 2)}</small></h3>
      <textarea
        value={s.text}
        rows={3}
        autoFocus
        onFocus={p.begin}
        onBlur={p.end}
        onChange={(e) => patch((x) => ({ ...x, text: e.target.value }))}
      />
      <div className="count">{s.text.length}자</div>
      <TimeFields start={s.start} end={s.end} min={prevEnd} max={nextStart} onChange={(a, b) => patch((x) => ({ ...x, start: a, end: b }))} />
      <div className="row">
        <button onClick={() => p.onPlayFrom(s.start)}>▶ 이 자막부터 재생</button>
        <button className="danger" onClick={() => { p.update((d) => ({ ...d, subtitles: d.subtitles.filter((x) => x.id !== s.id) })); p.onSelect(null); }}>삭제</button>
      </div>
      <Reasons reasons={s.review_reasons} onResolve={() => patch((x) => ({ ...x, needs_review: false, review_reasons: [] }))} />
      {s.words.length > 0 && (
        <div className="words">
          <h4>음성인식 원문 {original !== s.text.trim() && <small>(수정 전)</small>}</h4>
          <p className="hint">색이 진할수록 인식 확률이 낮습니다(참고용 — 확률이 높아도 틀릴 수 있음).</p>
          <div>
            {s.words.map((w, i) => (
              <span key={i} title={`확률 ${(w.p * 100).toFixed(0)}%`} style={{ background: `rgba(255,140,0,${(1 - w.p) * 0.8})` }}>
                {w.w}
              </span>
            ))}
          </div>
        </div>
      )}
      <button className="link" onClick={() => p.onSelect(null)}>← 목록으로</button>
    </div>
  );
}

const ORIGIN: Record<Cut["origin"], string> = {
  silence: "자동(무음 감지)",
  "no-speech": "자동 제안(말소리 없음)",
  user: "직접 추가/수정",
};

function CutEditor(p: Props & { cut: Cut }) {
  const c = p.cut;
  const patch = (fn: (x: Cut) => Cut) =>
    p.update((d) => ({ ...d, cuts: d.cuts.map((x) => (x.id === c.id ? fn(x) : x)) }));
  return (
    <div className="editor">
      <h3>컷 <small>{ORIGIN[c.origin]}</small></h3>
      <label className="check">
        <input type="checkbox" checked={c.enabled} onChange={(e) => patch((x) => ({ ...x, enabled: e.target.checked }))} />
        이 구간 잘라내기 {c.enabled ? "(적용됨)" : "(꺼짐 — 체크하면 적용)"}
      </label>
      <TimeFields start={c.start} end={c.end} min={0} max={p.duration}
        onChange={(a, b) => patch((x) => ({ ...x, start: a, end: b, origin: "user" }))} />
      <div className="row">
        <button onClick={() => p.onPlayFrom(Math.max(0, c.start - 2))}>▶ 2초 앞부터 재생</button>
        <button className="danger" onClick={() => { p.update((d) => ({ ...d, cuts: d.cuts.filter((x) => x.id !== c.id) })); p.onSelect(null); }}>삭제</button>
      </div>
      <Reasons reasons={c.review_reasons} onResolve={() => patch((x) => ({ ...x, needs_review: false, review_reasons: [] }))} />
      <p className="hint">타임라인에서 컷 양쪽 끝을 드래그해 범위를 조정할 수 있습니다. 컷을 더블클릭하면 적용/해제가 바뀝니다.</p>
      <button className="link" onClick={() => p.onSelect(null)}>← 목록으로</button>
    </div>
  );
}

// ---------------- 무음 설정 탭 ----------------

function SilenceTab(p: Props) {
  const [auto, setAuto] = useState(p.silence.threshold === "auto");
  const [th, setTh] = useState(p.silence.threshold === "auto" ? -35 : p.silence.threshold);
  const [minSil, setMinSil] = useState(p.silence.min_silence);
  const [pad, setPad] = useState(p.silence.pad);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async () => {
    if (!confirm("자동 컷을 새 설정으로 다시 만듭니다.\n직접 추가·수정한 컷과 자막은 유지되고, 삭제했던 자동 컷은 다시 나타날 수 있습니다. 진행할까요?")) return;
    setBusy(true);
    setErr("");
    try {
      await p.onRedetect({ threshold: auto ? "auto" : th, min_silence: minSil, pad });
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="silence">
      <label className="check">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        기준 음량 자동 (클립마다 배경소음에 맞춤, 권장)
      </label>
      {!auto && (
        <label>기준 음량: {th}dB (이보다 작으면 무음)
          <input type="range" min={-70} max={-10} step={1} value={th} onChange={(e) => setTh(+e.target.value)} />
        </label>
      )}
      <label>최소 무음 길이: {minSil.toFixed(1)}초 (이보다 짧은 쉼은 자르지 않음)
        <input type="range" min={0.2} max={3} step={0.1} value={minSil} onChange={(e) => setMinSil(+e.target.value)} />
      </label>
      <label>말 앞뒤 여유: {pad.toFixed(2)}초 (말끝 잘림 방지)
        <input type="range" min={0} max={0.5} step={0.05} value={pad} onChange={(e) => setPad(+e.target.value)} />
      </label>
      <button className="primary" disabled={busy} onClick={run}>{busy ? "감지 중…" : "이 설정으로 다시 감지"}</button>
      {err && <div className="error">{err}</div>}
      <h4>클립별 음량 분석</h4>
      <table className="analysis">
        <thead><tr><th>클립</th><th>배경소음</th><th>말소리</th><th>기준</th></tr></thead>
        <tbody>
          {p.clips.map((c, i) => {
            const a = p.analysis[c.id];
            return (
              <tr key={c.id} title={c.name}>
                <td>{i + 1}{a?.low_confidence ? " ⚠" : ""}</td>
                <td>{a?.noise_db ?? "-"}</td>
                <td>{a?.speech_db ?? "-"}</td>
                <td>{a?.threshold_db ?? "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint">단위 dB. 음성인식에서 말소리가 잡힌 곳은 자동 컷이 피해 갑니다.</p>
    </div>
  );
}

// ---------------- 자막 스타일 탭 ----------------

function StyleTab(p: Props) {
  const s = p.doc.style;
  const set = (patch: Partial<Style>, record = true) => p.update((d) => ({ ...d, style: { ...d.style, ...patch } }), record);
  const slider = (label: string, key: "size" | "outline" | "margin", min: number, max: number, step: number, unit: (v: number) => string) => (
    <label>{label}: {unit(s[key])}
      <input type="range" min={min} max={max} step={step} value={s[key]}
        onPointerDown={p.begin} onPointerUp={p.end}
        onChange={(e) => set({ [key]: +e.target.value } as Partial<Style>)} />
    </label>
  );
  return (
    <div className="style">
      <p className="hint">글꼴: 맑은 고딕 (Windows 기본). 미리보기 화면에 바로 반영됩니다.</p>
      {slider("글자 크기", "size", 2, 10, 0.1, (v) => `영상 높이의 ${v.toFixed(1)}%`)}
      {slider("외곽선 두께", "outline", 0, 0.2, 0.01, (v) => `${Math.round(v * 100)}%`)}
      {slider("가장자리 여백", "margin", 0, 30, 0.5, (v) => `${v.toFixed(1)}%`)}
      <div className="row">
        <label>글자색 <input type="color" value={s.color} onChange={(e) => set({ color: e.target.value.toUpperCase() })} /></label>
        <label>외곽선색 <input type="color" value={s.outline_color} onChange={(e) => set({ outline_color: e.target.value.toUpperCase() })} /></label>
      </div>
      <div className="row">
        <label className="check"><input type="radio" checked={s.position === "bottom"} onChange={() => set({ position: "bottom" })} /> 하단</label>
        <label className="check"><input type="radio" checked={s.position === "top"} onChange={() => set({ position: "top" })} /> 상단</label>
        <label className="check"><input type="checkbox" checked={s.shadow} onChange={(e) => set({ shadow: e.target.checked })} /> 그림자</label>
      </div>
    </div>
  );
}
