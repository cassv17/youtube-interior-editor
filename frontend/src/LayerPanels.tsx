import type { Asset, Clip } from "./api";
import { api } from "./api";
import { ColorField, NumField, Slider } from "./fields";
import type { EditDoc } from "./Inspector";
import { canRemoveTrack, fitOnTrack, grid, itemEnd, ofKind, type Marker, type Overlay, type Track } from "./layers";
import type { useLayerActions } from "./useLayerActions";
import { fmt } from "./time";

type Actions = ReturnType<typeof useLayerActions>;

interface Ctx {
  doc: EditDoc;
  assets: Asset[];
  clips: Clip[];
  actions: Actions;
  begin: () => void;
  end: () => void;
  onSelect: (s: { kind: "overlay" | "track" | "marker" | "piece" | "sub"; id: string } | null) => void;
  seekE: (e: number) => void;
  time: number; // 지금 재생 위치(결과 시간)
}

const TYPE_LABEL: Record<string, string> = { video: "영상", image: "이미지", audio: "음악·효과음", clip: "원본 영상 조각" };

function Back({ ctx }: { ctx: Ctx }) {
  return <button className="link" onClick={() => ctx.onSelect(null)}>← 목록으로</button>;
}

// ---------------- 추가 항목(영상·이미지·음악·원본 조각) ----------------

export function OverlayEditor({ o, ctx }: { o: Overlay; ctx: Ctx }) {
  const { doc, actions } = ctx;
  const asset = o.type === "clip" ? null : ctx.assets.find((a) => a.id === o.src);
  const clip = o.type === "clip" ? ctx.clips.find((c) => c.id === o.src) : null;
  const name = clip ? "원본 영상 조각" : asset?.name ?? "자료";
  const srcLen = clip ? clip.duration : asset?.duration ?? o.src_out;
  const visual = o.type !== "audio";
  const media = o.type !== "image";
  const others = doc.overlays.filter((x) => x.track === o.track && x.id !== o.id);
  const sameKind = ofKind(doc.tracks, visual ? "video" : "audio").filter((t) => !t.main);
  const patch = (p: Partial<Overlay>, rec = true) => actions.patchOverlay(o.id, p, rec);
  const nextStart = Math.min(Infinity, ...others.filter((x) => x.start >= itemEnd(o) - 1e-6).map((x) => x.start));

  const setStart = (v: string) => {
    const n = parseFloat(v);
    if (isFinite(n)) patch({ start: fitOnTrack(others, n, o.dur) });
  };
  const setDur = (v: string) => {
    const n = parseFloat(v);
    if (!isFinite(n)) return;
    let d = Math.max(0.1, grid(n));
    if (media) d = Math.min(d, srcLen - o.src_in);
    d = Math.min(d, nextStart - o.start);
    patch({ dur: d, src_out: media ? o.src_in + d : d, fade_in: Math.min(o.fade_in, d), fade_out: Math.min(o.fade_out, d) });
  };
  const setSrcIn = (v: string) => {
    const n = parseFloat(v);
    if (!isFinite(n)) return;
    const s = Math.max(0, Math.min(grid(n), srcLen - 0.1));
    const d = Math.min(o.dur, srcLen - s);
    patch({ src_in: s, src_out: s + d, dur: d });
  };
  const pct = (v: number | undefined, def: number) => Math.round((v ?? def) * 100);

  return (
    <div className="editor">
      <h3>{TYPE_LABEL[o.type]} <small>{name}</small></h3>
      <div className="time-fields">
        <label>시작(초)<NumField value={o.start} onCommit={setStart} /></label>
        <label>길이(초)<NumField value={o.dur} onCommit={setDur} /></label>
        <span className="len">{itemEnd(o).toFixed(2)}초에 끝남</span>
      </div>
      {media && (
        <div className="time-fields">
          <label>원본 시작(초)<NumField value={o.src_in} onCommit={setSrcIn} /></label>
          <span className="len">원본 전체 {srcLen.toFixed(1)}초</span>
        </div>
      )}
      <label className="field">
        레이어
        <select
          value={o.track}
          onChange={(e) => patch({ track: e.target.value, start: fitOnTrack(doc.overlays.filter((x) => x.track === e.target.value && x.id !== o.id), o.start, o.dur) })}
        >
          {sameKind.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
        </select>
      </label>
      {visual && (
        <>
          <h4>화면</h4>
          <p className="hint">위쪽 영상 레이어가 아래를 덮습니다. 크기를 줄이고 위치를 옮기면 화면 속 화면(PIP)이 됩니다.</p>
          <div className="row2"><span>가로 위치</span><Slider value={pct(o.x, 0.5)} min={-50} max={150} format={(v) => `${v}%`} begin={ctx.begin} end={ctx.end} onChange={(v, r) => patch({ x: v / 100 }, r)} /></div>
          <div className="row2"><span>세로 위치</span><Slider value={pct(o.y, 0.5)} min={-50} max={150} format={(v) => `${v}%`} begin={ctx.begin} end={ctx.end} onChange={(v, r) => patch({ y: v / 100 }, r)} /></div>
          <div className="row2"><span>크기</span><Slider value={pct(o.scale, 1)} min={5} max={400} format={(v) => `${v}%`} begin={ctx.begin} end={ctx.end} onChange={(v, r) => patch({ scale: v / 100 }, r)} /></div>
          <div className="row2"><span>투명도</span><Slider value={pct(o.opacity, 1)} min={0} max={100} format={(v) => `${v}%`} begin={ctx.begin} end={ctx.end} onChange={(v, r) => patch({ opacity: v / 100 }, r)} /></div>
          <div className="row">
            <button onClick={() => patch({ x: 0.5, y: 0.5, scale: 1 })}>화면 가득(가운데)</button>
            <button onClick={() => patch({ x: 0.8, y: 0.2, scale: 0.3 })}>오른쪽 위에 작게</button>
          </div>
        </>
      )}
      {(o.has_audio || o.type === "audio") && (
        <>
          <h4>소리</h4>
          <div className="row2"><span>볼륨</span><Slider value={Math.round(o.volume * 100)} min={0} max={200} format={(v) => `${v}%`} begin={ctx.begin} end={ctx.end} onChange={(v, r) => patch({ volume: v / 100 }, r)} /></div>
          <p className="hint">미리보기는 100%까지만 들립니다. 100%를 넘는 값은 내보낸 영상에서 반영됩니다.</p>
        </>
      )}
      <h4>페이드</h4>
      <div className="time-fields">
        <label>들어오기(초)<NumField value={o.fade_in} onCommit={(v) => { const n = parseFloat(v); if (isFinite(n)) patch({ fade_in: Math.max(0, Math.min(n, o.dur)) }); }} /></label>
        <label>나가기(초)<NumField value={o.fade_out} onCommit={(v) => { const n = parseFloat(v); if (isFinite(n)) patch({ fade_out: Math.max(0, Math.min(n, o.dur)) }); }} /></label>
      </div>
      <div className="row">
        <button onClick={() => ctx.seekE(o.start)}>▶ 이 항목으로 이동</button>
        <button onClick={() => actions.splitSelected(o.id, ctx.time)} title="재생 위치에서 둘로 나눕니다 (S)">✂ 재생 위치에서 나누기</button>
        <button className="danger" onClick={() => actions.deleteOverlay(o.id)}>삭제</button>
      </div>
      <Back ctx={ctx} />
    </div>
  );
}

// ---------------- 트랙 ----------------

export function TrackEditor({ t, ctx }: { t: Track; ctx: Ctx }) {
  const { doc, actions } = ctx;
  const items = doc.overlays.filter((o) => o.track === t.id).length + (t.kind === "subtitle" ? doc.subtitles.filter((s) => (s.track ?? ofKind(doc.tracks, "subtitle").slice(-1)[0]?.id) === t.id).length : 0);
  const st = { ...doc.style, ...(t.style ?? {}) };
  const setStyle = (p: Partial<typeof st>) => actions.patchTrack(t.id, { style: { ...(t.style ?? {}), ...p } });
  const kindLabel = t.kind === "video" ? "영상" : t.kind === "audio" ? "음성" : "자막";
  return (
    <div className="editor">
      <h3>{kindLabel} 레이어 <small>{t.id}{t.main ? " · 메인" : ""}</small></h3>
      <label className="field">
        이름
        <input value={t.name} maxLength={20} onChange={(e) => actions.patchTrack(t.id, { name: e.target.value })} />
      </label>
      {t.kind === "audio" ? (
        <>
          <label className="check"><input type="checkbox" checked={!!t.muted} onChange={(e) => actions.patchTrack(t.id, { muted: e.target.checked })} /> 음소거</label>
          <div className="row2"><span>레이어 볼륨</span><Slider value={Math.round((t.volume ?? 1) * 100)} min={0} max={200} format={(v) => `${v}%`} begin={ctx.begin} end={ctx.end}
            onChange={(v) => actions.patchTrack(t.id, { volume: v / 100 })} /></div>
          <p className="hint">{t.main ? "메인 음성은 메인 영상(조각)에 붙은 원래 소리입니다. " : ""}음성 레이어는 모두 섞여 들립니다. 미리보기는 100%까지만 들리고, 100%를 넘는 값은 내보낸 영상에 반영됩니다.</p>
        </>
      ) : (
        !t.main && <label className="check"><input type="checkbox" checked={!!t.hidden} onChange={(e) => actions.patchTrack(t.id, { hidden: e.target.checked })} /> 숨기기 (미리보기·내보내기에서 제외)</label>
      )}
      <label className="check"><input type="checkbox" checked={t.locked} onChange={(e) => actions.patchTrack(t.id, { locked: e.target.checked })} /> 잠금 (이 레이어의 항목을 옮기거나 고치지 못하게)</label>
      {t.kind === "video" && <p className="hint">{t.main ? "메인 영상: 결과 배치의 조각들입니다. " : ""}영상 레이어는 위쪽이 우선 표시됩니다(위 레이어가 아래를 덮음).</p>}
      {t.kind === "subtitle" && (
        <>
          <h4>이 자막 레이어의 스타일</h4>
          <p className="hint">비워 두면 '자막 스타일' 탭의 전체 기본 스타일을 따릅니다. 위쪽 레이어의 자막이 앞에 그려집니다.</p>
          <label className="field">
            위치
            <select value={st.position} onChange={(e) => setStyle({ position: e.target.value as "top" | "bottom" })}>
              <option value="bottom">하단</option>
              <option value="top">상단</option>
            </select>
          </label>
          <div className="row2"><span>여백</span><Slider value={st.margin} min={0} max={30} step={0.5} format={(v) => `${v}%`} begin={ctx.begin} end={ctx.end} onChange={(v) => setStyle({ margin: v })} /></div>
          <div className="row2"><span>크기</span><Slider value={st.size} min={2} max={12} step={0.5} format={(v) => `${v}`} begin={ctx.begin} end={ctx.end} onChange={(v) => setStyle({ size: v })} /></div>
          <div className="row2"><span>글자색</span><ColorField value={st.color} onChange={(v) => setStyle({ color: v })} /></div>
          <div className="row2"><span>외곽선색</span><ColorField value={st.outline_color} onChange={(v) => setStyle({ outline_color: v })} /></div>
          <div className="row"><button onClick={() => actions.patchTrack(t.id, { style: null })} disabled={!t.style}>전체 기본 스타일 따르기</button></div>
        </>
      )}
      <dl className="stats"><dt>들어 있는 항목</dt><dd>{items}개</dd></dl>
      <div className="row">
        <button className="danger" disabled={!canRemoveTrack(doc.tracks, t.id)} onClick={() => actions.removeTrackById(t.id)}
          title={t.main ? "메인 레이어는 지울 수 없습니다" : "종류마다 3개는 남겨 둡니다"}>레이어 삭제</button>
      </div>
      <Back ctx={ctx} />
    </div>
  );
}

// ---------------- 마커 ----------------

export function MarkerEditor({ m, ctx }: { m: Marker; ctx: Ctx }) {
  const { actions } = ctx;
  return (
    <div className="editor">
      <h3>마커 <small>{fmt(m.t, 2)}</small></h3>
      <label className="field">이름<input value={m.name} maxLength={40} placeholder="예: 거실 시작" onChange={(e) => actions.patchMarker(m.id, { name: e.target.value })} /></label>
      <div className="time-fields">
        <label>위치(초)<NumField value={m.t} onCommit={(v) => { const n = parseFloat(v); if (isFinite(n)) actions.patchMarker(m.id, { t: Math.max(0, grid(n)) }); }} /></label>
      </div>
      <div className="row2"><span>색</span><ColorField value={m.color} onChange={(v) => actions.patchMarker(m.id, { color: v })} /></div>
      <div className="row">
        <button onClick={() => ctx.seekE(m.t)}>▶ 마커로 이동</button>
        <button className="danger" onClick={() => actions.deleteMarker(m.id)}>삭제</button>
      </div>
      <p className="hint">M 키로 재생 위치에 마커를 찍고, ↑ ↓ 키로 편집점·마커 사이를 건너뜁니다.</p>
      <Back ctx={ctx} />
    </div>
  );
}

// ---------------- 자료 탭 ----------------

const ICON: Record<string, string> = { video: "🎞", image: "🖼", audio: "🎵" };

export function AssetsTab(p: {
  projectId: string;
  assets: Asset[];
  usedIds: Set<string>;
  busy: string;
  error: string;
  onUpload: (files: FileList | File[]) => void;
  onAdd: (a: Asset) => void;
  onRemove: (a: Asset) => void;
}) {
  return (
    <div className="assets">
      <h4>다른 레이어에 올릴 자료</h4>
      <p className="hint">
        B롤 영상·사진·로고·배경음악·효과음을 올려 두고, <b>＋ 타임라인에 올리기</b>를 누르거나 <b>끌어서</b> 결과 배치 타임라인의 영상(V2~)·음성(A2~) 레이어에 놓으세요.
        올린 파일은 이 컴퓨터 안에만 복사되며 원본은 바뀌지 않습니다.
      </p>
      <label
        className="drop small"
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); p.onUpload(e.dataTransfer.files); } }}
      >
        <input type="file" multiple accept="video/*,image/*,audio/*,.mp4,.mov,.m4v,.webm,.mkv,.avi,.png,.jpg,.jpeg,.webp,.bmp,.gif,.mp3,.wav,.m4a,.aac,.ogg,.flac,.wma"
          onChange={(e) => { if (e.target.files) p.onUpload(e.target.files); e.target.value = ""; }} />
        <span>자료 파일을 끌어오거나 <u>클릭해서 선택</u> (영상·이미지·음악, 여러 개 가능)</span>
      </label>
      {p.busy && <div className="hint">⏳ {p.busy}</div>}
      {p.error && <div className="error">{p.error}</div>}
      {p.assets.length === 0 && !p.busy && <p className="hint">아직 올린 자료가 없습니다.</p>}
      <ul className="asset-list">
        {p.assets.map((a) => (
          <li key={a.id} draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-asset", a.id); e.dataTransfer.effectAllowed = "copy"; }}>
            <span className="thumb">
              {a.kind === "image" ? <img src={api.assetUrl(p.projectId, a.id)} alt="" /> : <span>{ICON[a.kind]}</span>}
            </span>
            <span className="info">
              <b title={a.name}>{a.name}</b>
              <small>{a.kind === "image" ? "이미지" : `${fmt(a.duration, 1)}`}{a.kind === "video" ? ` · ${a.width}×${a.height}${a.has_audio ? " · 소리 있음" : ""}` : ""}</small>
            </span>
            <span className="btns">
              <button onClick={() => p.onAdd(a)} title="재생 위치에 올립니다">＋ 올리기</button>
              <button className="danger" disabled={p.usedIds.has(a.id)} onClick={() => p.onRemove(a)} title={p.usedIds.has(a.id) ? "타임라인에서 쓰는 중이라 지울 수 없습니다" : "자료 삭제"}>삭제</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
