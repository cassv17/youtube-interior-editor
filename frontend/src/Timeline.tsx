import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Clip, Cut, Group, Subtitle } from "./api";
import { clamp, fmt, snap, uid } from "./time";

export type Selection = { kind: "cut" | "sub"; id: string } | null;

export interface Doc {
  cuts: Cut[];
  subtitles: Subtitle[];
}

interface Props {
  duration: number;
  clips: Clip[];
  doc: Doc;
  wave: { frame_sec: number; db: number[] } | null;
  time: number;
  playing: boolean;
  pps: number; // 1초당 픽셀(확대 배율)
  setPps: (v: number) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onSeek: (t: number) => void;
  update: (fn: (d: Doc) => Doc, record?: boolean) => void;
  begin: () => void;
  end: () => void;
  groups: Group[];
  selectedClips: string[];
  onSelectClips: (ids: string[]) => void;
  onReorder: (order: string[]) => void; // 클립 순서 변경(그룹은 한 덩어리로 이동)
  onRenameGroup: (id: string) => void;
}

const RULER = 24;
const CLIPS = 30;
const GROUP_COLORS = ["#e0a33a", "#4fc1a6", "#c77dff", "#ff7b7b", "#5bb0ff", "#9ad14b"];

/** 이동 단위: 그룹이면 그룹 전체, 아니면 클립 하나 */
function blocksOf(clips: Clip[], groups: Group[]): string[][] {
  const groupOf = new Map<string, Group>();
  groups.forEach((g) => g.clips.forEach((c) => groupOf.set(c, g)));
  const out: string[][] = [];
  const done = new Set<string>();
  for (const c of clips) {
    if (done.has(c.id)) continue;
    const g = groupOf.get(c.id);
    const ids = g ? clips.filter((x) => g.clips.includes(x.id)).map((x) => x.id) : [c.id];
    ids.forEach((i) => done.add(i));
    out.push(ids);
  }
  return out;
}
const WAVE = 84;
const SUBS = 48;
const HEIGHT = RULER + CLIPS + WAVE + SUBS;
const MIN_LEN = 1 / 30;
const WAVE_FLOOR_DB = -60;

type Drag =
  | { type: "cut-l" | "cut-r"; id: string; t0: number; orig: Cut }
  | { type: "sub-l" | "sub-r" | "sub-move"; id: string; t0: number; orig: Subtitle }
  | { type: "new-cut"; t0: number; x0: number; id: string | null };

export default function Timeline(p: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const drag = useRef<Drag | null>(null);
  const width = Math.max(p.duration * p.pps, view.width);
  // 클립 끌어서 순서 바꾸기
  type ClipDrag = { block: number; x0: number; moved: boolean; insertAt: number };
  const [clipDragState, setClipDragState] = useState<ClipDrag | null>(null);
  // 누르고 떼는 사이가 짧아도 최신 값을 읽도록 ref에도 둔다(상태는 화면 표시용)
  const clipDragRef = useRef<ClipDrag | null>(null);
  const clipDrag = clipDragState;
  const setClipDrag = (v: ClipDrag | null) => {
    clipDragRef.current = v;
    setClipDragState(v);
  };
  const blocks = blocksOf(p.clips, p.groups);
  const clipById = new Map(p.clips.map((c) => [c.id, c]));
  const blockSpan = (b: string[]) => {
    const first = clipById.get(b[0])!;
    const last = clipById.get(b[b.length - 1])!;
    return [first.offset, last.offset + last.duration] as const;
  };

  // 스크롤 위치/화면 너비 추적
  useLayoutEffect(() => {
    const el = scroller.current!;
    const sync = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, []);

  // Ctrl + 휠: 마우스 위치를 기준으로 확대/축소
  useEffect(() => {
    const el = scroller.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = (el.scrollLeft + x) / p.pps;
      const next = clamp(p.pps * (e.deltaY < 0 ? 1.25 : 0.8), 2, 600);
      p.setPps(next);
      requestAnimationFrame(() => (el.scrollLeft = t * next - x));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [p.pps, p.setPps]);

  // 재생 중에는 재생 위치가 화면 밖으로 나가지 않게 따라간다
  useEffect(() => {
    const el = scroller.current;
    if (!el || !p.playing) return;
    const x = p.time * p.pps;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 80;
  }, [p.time, p.playing, p.pps]);

  // 파형: 보이는 부분만 캔버스에 그린다(긴 영상도 가볍게)
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(view.width * dpr);
    c.height = Math.round(WAVE * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, view.width, WAVE);
    if (!p.wave) return;
    const { db, frame_sec } = p.wave;
    const styles = getComputedStyle(c);
    g.fillStyle = styles.getPropertyValue("--wave").trim() || "#5b8def";
    const mid = WAVE / 2;
    for (let x = 0; x < view.width; x++) {
      const t0 = (view.left + x) / p.pps;
      const t1 = (view.left + x + 1) / p.pps;
      if (t0 >= p.duration) break;
      let i0 = Math.floor(t0 / frame_sec);
      const i1 = Math.max(i0 + 1, Math.ceil(t1 / frame_sec));
      let peak = -120;
      for (; i0 < i1 && i0 < db.length; i0++) peak = Math.max(peak, db[i0]);
      const amp = clamp((peak - WAVE_FLOOR_DB) / -WAVE_FLOOR_DB, 0, 1);
      const hgt = Math.max(1, amp * (WAVE - 8));
      g.fillRect(x, mid - hgt / 2, 1, hgt);
    }
  }, [p.wave, p.pps, view, p.duration]);

  const tAt = (clientX: number) => {
    const el = scroller.current!;
    const rect = el.getBoundingClientRect();
    return clamp((clientX - rect.left + el.scrollLeft) / p.pps, 0, p.duration);
  };

  // ---------- 드래그 ----------
  const startDrag = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId); // 요소 밖으로 끌어도 계속 추적
    } catch {
      /* 캡처를 못 해도 타임라인 영역 안에서는 드래그가 동작한다 */
    }
    drag.current = d;
    if (d.type !== "new-cut") p.begin();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = snap(tAt(e.clientX));
    if (d.type === "new-cut") {
      if (d.id === null) {
        if (Math.abs(e.clientX - d.x0) < 4) return;
        d.id = uid("cut");
        p.begin();
        const id = d.id;
        p.onSelect({ kind: "cut", id });
        p.update((doc) => ({
          ...doc,
          cuts: [...doc.cuts, newCut(id, Math.min(d.t0, t), Math.max(d.t0, t))],
        }), false);
        return;
      }
      const id = d.id;
      p.update((doc) => ({
        ...doc,
        cuts: doc.cuts.map((c) => (c.id === id ? { ...c, start: Math.min(d.t0, t), end: Math.max(d.t0, t) } : c)),
      }), false);
      return;
    }
    const dt = t - d.t0;
    if (d.type === "cut-l" || d.type === "cut-r") {
      const o = d.orig;
      const start = d.type === "cut-l" ? clamp(snap(o.start + dt), 0, o.end - MIN_LEN) : o.start;
      const end = d.type === "cut-r" ? clamp(snap(o.end + dt), o.start + MIN_LEN, p.duration) : o.end;
      p.update((doc) => ({
        ...doc,
        cuts: doc.cuts.map((c) => (c.id === d.id ? edited({ ...c, start, end }) : c)),
      }), false);
    } else {
      const o = d.orig;
      p.update((doc) => {
        const others = doc.subtitles.filter((s) => s.id !== d.id);
        const prevEnd = Math.max(0, ...others.filter((s) => s.end <= o.start + 1e-6).map((s) => s.end));
        const nextStart = Math.min(p.duration, ...others.filter((s) => s.start >= o.end - 1e-6).map((s) => s.start));
        let { start, end } = o;
        if (d.type === "sub-l") start = clamp(snap(o.start + dt), prevEnd, o.end - 0.1);
        if (d.type === "sub-r") end = clamp(snap(o.end + dt), o.start + 0.1, nextStart);
        if (d.type === "sub-move") {
          const len = o.end - o.start;
          start = clamp(snap(o.start + dt), prevEnd, nextStart - len);
          end = start + len;
        }
        return { ...doc, subtitles: doc.subtitles.map((s) => (s.id === d.id ? { ...s, start, end } : s)) };
      }, false);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.type === "new-cut" && d.id === null) {
      p.onSeek(tAt(e.clientX)); // 드래그 없이 클릭 → 그 위치로 이동
      return;
    }
    p.end();
  };

  // ---------- 눈금자 ----------
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * p.pps >= 70) ?? 600;
  const ticks: number[] = [];
  for (let t = Math.floor(view.left / p.pps / step) * step; t * p.pps < view.left + view.width && t <= p.duration; t += step)
    ticks.push(t);

  const visible = (s: number, e: number) => e * p.pps >= view.left - 50 && s * p.pps <= view.left + view.width + 50;

  return (
    <div className="timeline">
      <div className="tl-labels">
        <div style={{ height: RULER }} />
        <div style={{ height: CLIPS }}>클립</div>
        <div style={{ height: WAVE }}>
          음성 · 컷
          <small>빈 곳 드래그 = 컷 추가</small>
        </div>
        <div style={{ height: SUBS }}>
          자막
          <small>빈 곳 더블클릭 = 추가</small>
        </div>
      </div>
      <div
        className="tl-scroll"
        ref={scroller}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="tl-content" style={{ width, height: HEIGHT }}>
          {/* 눈금자 */}
          <div className="tl-ruler" style={{ height: RULER }} onPointerDown={(e) => p.onSeek(tAt(e.clientX))}>
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: t * p.pps }}>
                {fmt(t, step < 1 ? 1 : 0)}
              </div>
            ))}
          </div>

          {/* 클립 구간: 클릭=선택(Ctrl/Shift로 여러 개), 끌기=순서 변경 */}
          <div className="tl-clips" style={{ top: RULER, height: CLIPS }}>
            {p.groups.map((g, gi) => {
              const ids = p.clips.filter((c) => g.clips.includes(c.id));
              if (!ids.length) return null;
              const [s0, e0] = blockSpan(ids.map((c) => c.id));
              return (
                <div key={g.id} className="group-band" style={{ left: s0 * p.pps, width: (e0 - s0) * p.pps, borderColor: GROUP_COLORS[gi % GROUP_COLORS.length] }}>
                  <span
                    className="group-tag"
                    style={{ background: GROUP_COLORS[gi % GROUP_COLORS.length] }}
                    title="더블클릭하면 이름 변경"
                    onDoubleClick={() => p.onRenameGroup(g.id)}
                  >
                    {g.name}
                  </span>
                </div>
              );
            })}
            {p.clips.map((c, i) => {
              const bi = blocks.findIndex((b) => b.includes(c.id));
              const dragging = clipDrag?.moved && clipDrag.block === bi;
              return (
                <div
                  key={c.id}
                  className={`clip clip-${i % 2} ${p.selectedClips.includes(c.id) ? "sel" : ""} ${dragging ? "dragging" : ""}`}
                  style={{ left: c.offset * p.pps, width: c.duration * p.pps }}
                  title={`${c.name} (${fmt(c.duration)})
끌어서 순서 변경 · Ctrl+클릭으로 여러 개 선택`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    try {
                      (e.currentTarget as Element).setPointerCapture(e.pointerId);
                    } catch {
                      /* 무시 */
                    }
                    setClipDrag({ block: bi, x0: e.clientX, moved: false, insertAt: bi });
                  }}
                  onPointerMove={(e) => {
                    const cd = clipDragRef.current;
                    if (!cd) return;
                    if (!cd.moved && Math.abs(e.clientX - cd.x0) < 6) return;
                    const t = tAt(e.clientX);
                    const others = blocks.filter((_, k) => k !== cd.block);
                    const insertAt = others.filter((b) => {
                      const [a, z] = blockSpan(b);
                      return (a + z) / 2 < t;
                    }).length;
                    setClipDrag({ ...cd, moved: true, insertAt });
                  }}
                  onPointerUp={(e) => {
                    const d = clipDragRef.current;
                    setClipDrag(null);
                    if (!d) return;
                    if (!d.moved) {
                      // 클릭: 선택 (Ctrl/Shift = 추가/해제)
                      if (e.ctrlKey || e.metaKey || e.shiftKey) {
                        p.onSelectClips(p.selectedClips.includes(c.id) ? p.selectedClips.filter((x) => x !== c.id) : [...p.selectedClips, c.id]);
                      } else {
                        p.onSelectClips([c.id]);
                        p.onSeek(c.offset);
                      }
                      return;
                    }
                    const others = blocks.filter((_, k) => k !== d.block);
                    const moved = [...others.slice(0, d.insertAt), blocks[d.block], ...others.slice(d.insertAt)];
                    const order = moved.flat();
                    if (order.join() !== p.clips.map((x) => x.id).join()) p.onReorder(order);
                  }}
                  onPointerCancel={() => setClipDrag(null)}
                >
                  {i + 1}. {c.name}
                </div>
              );
            })}
            {clipDrag?.moved && (() => {
              const others = blocks.filter((_, k) => k !== clipDrag.block);
              const x = clipDrag.insertAt < others.length ? blockSpan(others[clipDrag.insertAt])[0] : blockSpan(others[others.length - 1] ?? blocks[0])[1];
              return <div className="insert-mark" style={{ left: x * p.pps }} />;
            })()}
          </div>

          {/* 파형 + 컷 */}
          <div
            className="tl-wave"
            style={{ top: RULER + CLIPS, height: WAVE }}
            onPointerDown={(e) => startDrag(e, { type: "new-cut", t0: snap(tAt(e.clientX)), x0: e.clientX, id: null })}
          >
            <canvas ref={canvas} style={{ left: view.left, width: view.width, height: WAVE }} />
            {p.doc.cuts.filter((c) => visible(c.start, c.end)).map((c) => {
              const sel = p.selection?.kind === "cut" && p.selection.id === c.id;
              return (
                <div
                  key={c.id}
                  className={`cut ${c.enabled ? "on" : "off"} ${sel ? "sel" : ""} ${c.needs_review ? "review" : ""}`}
                  style={{ left: c.start * p.pps, width: Math.max(2, (c.end - c.start) * p.pps) }}
                  title={`${c.enabled ? "잘라낼 구간" : "제안(꺼짐) — 더블클릭하면 적용"}  ${fmt(c.start, 2)} ~ ${fmt(c.end, 2)}${
                    c.review_reasons.length ? "\n⚠ " + c.review_reasons.join("\n⚠ ") : ""
                  }`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    p.onSelect({ kind: "cut", id: c.id });
                  }}
                  onDoubleClick={() =>
                    p.update((doc) => ({
                      ...doc,
                      cuts: doc.cuts.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)),
                    }))
                  }
                >
                  {c.needs_review && <span className="badge">!</span>}
                  <div className="h l" onPointerDown={(e) => startDrag(e, { type: "cut-l", id: c.id, t0: snap(tAt(e.clientX)), orig: c })} />
                  <div className="h r" onPointerDown={(e) => startDrag(e, { type: "cut-r", id: c.id, t0: snap(tAt(e.clientX)), orig: c })} />
                </div>
              );
            })}
          </div>

          {/* 자막 */}
          <div
            className="tl-subs"
            style={{ top: RULER + CLIPS + WAVE, height: SUBS }}
            onPointerDown={(e) => p.onSeek(tAt(e.clientX))}
            onDoubleClick={(e) => {
              const t = snap(tAt(e.clientX));
              const next = p.doc.subtitles.filter((s) => s.start > t).map((s) => s.start);
              const end = Math.min(t + 2, p.duration, ...next);
              if (end - t < 0.3) return;
              const id = uid("sub");
              p.update((doc) => ({
                ...doc,
                subtitles: [...doc.subtitles, newSub(id, t, end)].sort((a, b) => a.start - b.start),
              }));
              p.onSelect({ kind: "sub", id });
            }}
          >
            {p.doc.subtitles.filter((s) => visible(s.start, s.end)).map((s) => {
              const sel = p.selection?.kind === "sub" && p.selection.id === s.id;
              return (
                <div
                  key={s.id}
                  className={`sub ${sel ? "sel" : ""} ${s.needs_review ? "review" : ""}`}
                  style={{ left: s.start * p.pps, width: Math.max(2, (s.end - s.start) * p.pps) }}
                  title={`${s.text}\n${fmt(s.start, 2)} ~ ${fmt(s.end, 2)}${s.review_reasons.length ? "\n⚠ " + s.review_reasons.join("\n⚠ ") : ""}`}
                  onPointerDown={(e) => {
                    p.onSelect({ kind: "sub", id: s.id });
                    startDrag(e, { type: "sub-move", id: s.id, t0: snap(tAt(e.clientX)), orig: s });
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <span>{s.text}</span>
                  <div className="h l" onPointerDown={(e) => startDrag(e, { type: "sub-l", id: s.id, t0: snap(tAt(e.clientX)), orig: s })} />
                  <div className="h r" onPointerDown={(e) => startDrag(e, { type: "sub-r", id: s.id, t0: snap(tAt(e.clientX)), orig: s })} />
                </div>
              );
            })}
          </div>

          {/* 클립 경계선 + 재생 위치 */}
          {p.clips.slice(1).map((c) => (
            <div key={c.id} className="boundary" style={{ left: c.offset * p.pps, height: HEIGHT }} />
          ))}
          <div className="playhead" style={{ left: p.time * p.pps, height: HEIGHT }} />
        </div>
      </div>
    </div>
  );
}

/** 자동 컷을 손으로 고치면 '직접 수정'으로 바꾼다(다시 감지해도 유지되도록). */
function edited(c: Cut): Cut {
  return c.origin === "user" ? c : { ...c, origin: "user" };
}

export function newCut(id: string, start: number, end: number): Cut {
  return { id, clip_id: "", start, end, origin: "user", enabled: true, needs_review: false, review_reasons: [] };
}

export function newSub(id: string, start: number, end: number): Subtitle {
  return { id, clip_id: "", start, end, text: "새 자막", needs_review: false, review_reasons: [], words: [] };
}
