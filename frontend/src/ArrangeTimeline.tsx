import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SpeedRange } from "./api";
import { eToP, moveItem, type Item, type Placed, type SubInstance } from "./layout";
import { clamp, fmt, snap } from "./time";

/** 결과 배치 보기 타임라인: 가로축이 '결과 영상 시간'이다. 조각을 끌어 순서를 바꾸거나 빈칸을 둔다. */

const RULER = 24;
const PIECES = 52;
const SPEEDS = 20;
const WAVE = 70;
const SUBS = 44;
const HEIGHT = RULER + PIECES + SPEEDS + WAVE + SUBS;
const WAVE_FLOOR_DB = -60;
const MAGNET_PX = 10;

export type ArrangeSelection = { kind: "piece" | "sub"; id: string } | null;

interface Props {
  items: Item[];
  placed: Placed[];
  total: number;
  speeds: SpeedRange[];
  subs: SubInstance[];
  wave: { frame_sec: number; db: number[] } | null;
  time: number;
  playing: boolean;
  pps: number;
  setPps: (v: number) => void;
  magnet: boolean;
  selection: ArrangeSelection;
  multiSubs: string[];
  onSelect: (s: ArrangeSelection, additive?: boolean) => void;
  onSeek: (e: number) => void;
  onLayout: (items: Item[], record: boolean) => void;
  onMoveFreeSub: (id: string, e0: number, e1: number, record: boolean) => void;
  onSubMenu: (id: string, x: number, y: number) => void;
  begin: () => void;
  end: () => void;
}

type Drag =
  | { type: "piece"; id: string; grab: number; base: Item[]; moved: boolean; x0: number }
  | { type: "free-move" | "free-l" | "free-r"; id: string; t0: number; o0: number; o1: number };

export default function ArrangeTimeline(p: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  // 마지막 조각 뒤로 끌어 놓을 여유 공간(10초)
  const span = Math.max(p.total + 10, 30);
  const width = Math.max(span * p.pps, view.width);

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

  useEffect(() => {
    const el = scroller.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const x = e.clientX - el.getBoundingClientRect().left;
      const t = (el.scrollLeft + x) / p.pps;
      const next = clamp(p.pps * (e.deltaY < 0 ? 1.25 : 0.8), 2, 600);
      p.setPps(next);
      requestAnimationFrame(() => (el.scrollLeft = t * next - x));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [p.pps, p.setPps]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !p.playing) return;
    const x = p.time * p.pps;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 80;
  }, [p.time, p.playing, p.pps]);

  const eAt = (clientX: number) => {
    const el = scroller.current!;
    return Math.max(0, (clientX - el.getBoundingClientRect().left + el.scrollLeft) / p.pps);
  };

  // 파형: 보이는 부분만, 조각 위치에 맞춰 그린다(빈칸은 비움)
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
    g.fillStyle = getComputedStyle(c).getPropertyValue("--wave").trim() || "#5b8def";
    const mid = WAVE / 2;
    for (let x = 0; x < view.width; x++) {
      const e0 = (view.left + x) / p.pps;
      const e1 = (view.left + x + 1) / p.pps;
      const h0 = eToP(p.placed, e0);
      if (!h0) continue;
      const h1 = eToP(p.placed, Math.max(e0, e1 - 1e-6));
      const pa = h0.p;
      const pb = h1 && h1.item === h0.item ? h1.p : pa + frame_sec;
      let i0 = Math.floor(Math.min(pa, pb) / frame_sec);
      const i1 = Math.max(i0 + 1, Math.ceil(Math.max(pa, pb) / frame_sec));
      let peak = -120;
      for (; i0 < i1 && i0 < db.length; i0++) peak = Math.max(peak, db[i0]);
      const amp = clamp((peak - WAVE_FLOOR_DB) / -WAVE_FLOOR_DB, 0, 1);
      const hgt = Math.max(1, amp * (WAVE - 8));
      g.fillRect(x, mid - hgt / 2, 1, hgt);
    }
  }, [p.wave, p.placed, p.pps, view]);

  // ---------- 드래그 ----------
  const capture = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* 캡처를 못 해도 타임라인 안에서는 동작한다 */
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const e0 = eAt(e.clientX);
    if (d.type === "piece") {
      if (!d.moved) {
        if (Math.abs(e.clientX - d.x0) < 4) return;
        d.moved = true;
      }
      const r = moveItem(d.base, p.speeds, d.id, e0 - d.grab, {
        magnet: p.magnet,
        threshold: MAGNET_PX / p.pps,
        playhead: p.time,
      });
      setSnapAt(r.snap);
      p.onLayout(r.items, false);
      return;
    }
    const dt = snap(e0) - d.t0;
    if (d.type === "free-move") p.onMoveFreeSub(d.id, Math.max(0, snap(d.o0 + dt)), Math.max(0, snap(d.o0 + dt)) + (d.o1 - d.o0), false);
    if (d.type === "free-l") p.onMoveFreeSub(d.id, clamp(snap(d.o0 + dt), 0, d.o1 - 0.1), d.o1, false);
    if (d.type === "free-r") p.onMoveFreeSub(d.id, d.o0, Math.max(d.o0 + 0.1, snap(d.o1 + dt)), false);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setSnapAt(null);
    if (d) p.end();
  };

  // ---------- 눈금 ----------
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * p.pps >= 70) ?? 600;
  const ticks: number[] = [];
  for (let t = Math.floor(view.left / p.pps / step) * step; t * p.pps < view.left + view.width; t += step) ticks.push(t);
  const visible = (s: number, e: number) => e * p.pps >= view.left - 50 && s * p.pps <= view.left + view.width + 50;

  // 빈칸 표시용: 각 조각 앞의 빈칸 구간
  const gaps = p.placed
    .map((it, i) => ({ s: i === 0 ? 0 : p.placed[i - 1].e1, e: it.atoms.length ? it.atoms[0].e0 : it.e0 }))
    .filter((g) => g.e - g.s > 1 / 30);

  const speedBadges = p.placed.flatMap((it) => it.atoms.filter((a) => Math.abs(a.speed - 1) > 1e-6));

  return (
    <div className="timeline arrange">
      <div className="tl-labels">
        <div style={{ height: RULER }} />
        <div style={{ height: PIECES }}>
          조각
          <small>끌어서 이동</small>
        </div>
        <div style={{ height: SPEEDS }}>속도</div>
        <div style={{ height: WAVE }}>
          음성
          <small>결과 순서 기준</small>
        </div>
        <div style={{ height: SUBS }}>
          자막
          <small>우클릭 = 메뉴</small>
        </div>
      </div>
      <div className="tl-scroll" ref={scroller} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div className="tl-content" style={{ width, height: HEIGHT }}>
          <div className="tl-ruler" style={{ height: RULER }} onPointerDown={(e) => p.onSeek(eAt(e.clientX))}>
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: t * p.pps }}>{fmt(t, 0)}</div>
            ))}
          </div>

          {/* 조각 */}
          <div
            className="tl-pieces arr-pieces"
            style={{ top: RULER, height: PIECES }}
            onPointerDown={(e) => {
              p.onSeek(eAt(e.clientX));
              p.onSelect(null);
            }}
          >
            {gaps.filter((g) => visible(g.s, g.e)).map((g, i) => (
              <div key={i} className="arr-gap" style={{ left: g.s * p.pps, width: (g.e - g.s) * p.pps }} title={`빈칸 ${(g.e - g.s).toFixed(2)}초 (검은 화면·무음)`}>
                <span>{(g.e - g.s).toFixed(1)}초 빈칸</span>
              </div>
            ))}
            {p.placed.filter((it) => visible(it.e0, it.e1)).map((it) => {
              const sel = p.selection?.kind === "piece" && p.selection.id === it.id;
              const idx = p.placed.indexOf(it);
              return (
                <div
                  key={it.id}
                  className={`arr-piece ${sel ? "sel" : ""}`}
                  style={{ left: it.e0 * p.pps + 1, width: Math.max(3, (it.e1 - it.e0) * p.pps - 2) }}
                  title={`조각 ${idx + 1} · 결과 ${fmt(it.e0, 2)} ~ ${fmt(it.e1, 2)}\n원본 ${fmt(it.a, 2)} ~ ${fmt(it.b, 2)}\n끌어서 옮기기`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    capture(e);
                    p.onSelect({ kind: "piece", id: it.id });
                    p.onSeek(eAt(e.clientX));
                    p.begin();
                    drag.current = { type: "piece", id: it.id, grab: eAt(e.clientX) - it.e0, base: p.items, moved: false, x0: e.clientX };
                  }}
                >
                  <b>{idx + 1}</b>
                  <span>{(it.e1 - it.e0).toFixed(1)}초</span>
                </div>
              );
            })}
          </div>

          {/* 속도(보기만) */}
          <div className="tl-speed arr-speed" style={{ top: RULER + PIECES, height: SPEEDS }}>
            {speedBadges.filter((a) => visible(a.e0, a.e1)).map((a, i) => (
              <div key={i} className={`speed ${a.speed < 1 ? "slow" : ""}`} style={{ left: a.e0 * p.pps, width: Math.max(2, (a.e1 - a.e0) * p.pps) }} title="배속은 '원본 기준' 보기에서 바꿉니다">
                <span>{a.speed}x</span>
              </div>
            ))}
          </div>

          {/* 파형 */}
          <div className="tl-wave arr-wave" style={{ top: RULER + PIECES + SPEEDS, height: WAVE, cursor: "pointer" }} onPointerDown={(e) => p.onSeek(eAt(e.clientX))}>
            <canvas ref={canvas} style={{ left: view.left, width: view.width, height: WAVE }} />
          </div>

          {/* 자막 */}
          <div className="tl-subs" style={{ top: RULER + PIECES + SPEEDS + WAVE, height: SUBS }} onPointerDown={(e) => p.onSeek(eAt(e.clientX))}>
            {p.subs.filter((s) => visible(s.e0, s.e1)).map((s, i) => {
              const sel = (p.selection?.kind === "sub" && p.selection.id === s.id) || p.multiSubs.includes(s.id);
              return (
                <div
                  key={`${s.id}-${i}`}
                  className={`sub ${sel ? "sel" : ""} ${s.free ? "free" : ""}`}
                  style={{ left: s.e0 * p.pps, width: Math.max(2, (s.e1 - s.e0) * p.pps) }}
                  title={`${s.text}\n${fmt(s.e0, 2)} ~ ${fmt(s.e1, 2)}\n${s.free ? "분리된 자막 (끌어서 이동 · 우클릭 메뉴)" : "조각을 따라 이동합니다 (우클릭 → 그룹 해제로 분리)"}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    p.onSelect({ kind: "sub", id: s.id }, e.ctrlKey || e.metaKey);
                    if (s.free && !(e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      capture(e);
                      p.begin();
                      drag.current = { type: "free-move", id: s.id, t0: snap(eAt(e.clientX)), o0: s.e0, o1: s.e1 };
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    p.onSubMenu(s.id, e.clientX, e.clientY);
                  }}
                >
                  <span>{s.free ? "🔓 " : ""}{s.text}</span>
                  {s.free && (
                    <>
                      <div className="h l" onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); capture(e); p.begin(); drag.current = { type: "free-l", id: s.id, t0: snap(eAt(e.clientX)), o0: s.e0, o1: s.e1 }; }} />
                      <div className="h r" onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); capture(e); p.begin(); drag.current = { type: "free-r", id: s.id, t0: snap(eAt(e.clientX)), o0: s.e0, o1: s.e1 }; }} />
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {snapAt !== null && <div className="snap-line" style={{ left: snapAt * p.pps, height: HEIGHT }} />}
          {p.placed.slice(1).map((it, i) => (
            it.e0 - p.placed[i].e1 < 1 / 30 ? <div key={it.id} className="boundary" style={{ left: it.e0 * p.pps, height: HEIGHT }} /> : null
          ))}
          <div className="playhead" style={{ left: p.time * p.pps, height: HEIGHT }} />
        </div>
      </div>
    </div>
  );
}
