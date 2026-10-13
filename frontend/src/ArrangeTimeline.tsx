import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Asset, Clip, SpeedRange } from "./api";
import { eToP, moveItem, type Item, type Placed, type SubInstance } from "./layout";
import {
  fitOnTrack, grid, itemEnd, snapPoint, snapStart, trimOverlay, type Marker, type Overlay, type Track,
} from "./layers";
import { clamp, fmt, snap } from "./time";

/**
 * 결과 배치 보기 타임라인: 가로축은 '결과 영상 시간', 세로는 레이어(트랙)다.
 * 자막(위) → 영상(위 레이어가 우선 표시, 맨 아래가 메인) → 음성(메인 음성 + 추가 음성) 순서로 쌓인다.
 */

const RULER = 26;
const WAVE_FLOOR_DB = -60;
const MAGNET_PX = 10;

const rowHeight = (t: Track) => (t.kind === "video" && t.main ? 54 : t.kind === "audio" && t.main ? 60 : t.kind === "subtitle" ? 28 : 34);

export type ArrangeSelection = { kind: "piece" | "sub" | "overlay" | "track" | "marker"; id: string } | null;

interface Props {
  items: Item[];
  placed: Placed[];
  speeds: SpeedRange[];
  tracks: Track[];
  overlays: Overlay[];
  assets: Asset[];
  clips: Clip[];
  markers: Marker[];
  subs: SubInstance[];
  wave: { frame_sec: number; db: number[] } | null;
  time: number;
  playing: boolean;
  total: number; // 결과 전체 길이(레이어 포함)
  pps: number;
  setPps: (v: number) => void;
  magnet: boolean;
  selection: ArrangeSelection;
  multiSubs: string[];
  onSelect: (s: ArrangeSelection, additive?: boolean) => void;
  onSeek: (e: number) => void;
  onLayout: (items: Item[], record: boolean) => void;
  onOverlays: (next: Overlay[], record: boolean) => void;
  onMoveFreeSub: (id: string, e0: number, e1: number, record: boolean) => void;
  onSubTrack: (id: string, track: string, record: boolean) => void;
  onSubMenu: (id: string, x: number, y: number) => void;
  onPieceMenu: (id: string, x: number, y: number) => void;
  onOverlayMenu: (id: string, x: number, y: number) => void;
  onTrackPatch: (id: string, patch: Partial<Track>) => void;
  onDropAsset: (assetId: string, trackId: string, e: number) => void;
  begin: () => void;
  end: () => void;
}

type Drag =
  | { type: "piece"; id: string; grab: number; base: Item[]; moved: boolean; x0: number }
  | { type: "ov-move"; id: string; grab: number; base: Overlay[]; moved: boolean; x0: number; y0: number }
  | { type: "ov-l" | "ov-r"; id: string; base: Overlay[] }
  | { type: "free-move" | "free-l" | "free-r"; id: string; t0: number; o0: number; o1: number }
  | { type: "sub-vert"; id: string }
  | { type: "scrub" };

const OV_ICON: Record<string, string> = { video: "🎞", image: "🖼", audio: "🎵", clip: "✂" };

export default function ArrangeTimeline(p: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const heads = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);

  const span = Math.max(p.total + 10, 30);
  const width = Math.max(span * p.pps, view.width);

  // 트랙 행 위치
  const rows: { t: Track; top: number; h: number }[] = [];
  let y = RULER;
  for (const t of p.tracks) {
    const h = rowHeight(t);
    rows.push({ t, top: y, h });
    y += h;
  }
  const HEIGHT = y;
  const rowOf = (id: string) => rows.find((r) => r.t.id === id);
  const subTracks = p.tracks.filter((t) => t.kind === "subtitle");
  const defaultSub = subTracks[subTracks.length - 1]?.id ?? "S1";
  const subTrackOf = (s: { track?: string }) => (s.track && subTracks.some((t) => t.id === s.track) ? s.track : defaultSub);
  const mainV = p.tracks.find((t) => t.kind === "video" && t.main);
  const mainA = p.tracks.find((t) => t.kind === "audio" && t.main);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const sync = () => {
      setView({ left: el.scrollLeft, width: el.clientWidth });
      if (heads.current) heads.current.scrollTop = el.scrollTop;
    };
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
  const yAt = (clientY: number) => {
    const el = scroller.current!;
    return clientY - el.getBoundingClientRect().top + el.scrollTop;
  };
  /** 세로 위치에 있는 같은 종류의 트랙 id(없으면 null) */
  const trackAtY = (clientY: number, kind: Track["kind"], allowMain = false): string | null => {
    const yy = yAt(clientY);
    const r = rows.find((x) => yy >= x.top && yy < x.top + x.h);
    if (!r || r.t.kind !== kind || (r.t.main && !allowMain) || r.t.locked) return null;
    return r.t.id;
  };

  // 파형(메인 음성 줄): 보이는 부분만, 조각 위치에 맞춰 그린다
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const h = mainA ? rowHeight(mainA) : 60;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(view.width * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, view.width, h);
    if (!p.wave) return;
    const { db, frame_sec } = p.wave;
    g.fillStyle = getComputedStyle(c).getPropertyValue("--wave").trim() || "#5b8def";
    const mid = h / 2;
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
      const hh = Math.max(1, amp * (h - 8));
      g.fillRect(x, mid - hh / 2, 1, hh);
    }
  }, [p.wave, p.placed, p.pps, view, mainA?.id]);

  // ---------- 자석 기준점 ----------
  const points = (excludeId?: string) => [
    0,
    p.time,
    ...p.markers.map((m) => m.t),
    ...p.placed.flatMap((it) => [it.e0, it.e1]),
    ...p.overlays.filter((o) => o.id !== excludeId).flatMap((o) => [o.start, itemEnd(o)]),
  ];
  const srcLen = (o: Overlay) =>
    o.type === "clip" ? p.clips.find((c) => c.id === o.src)?.duration ?? o.src_out : p.assets.find((a) => a.id === o.src)?.duration ?? o.src_out;
  const nameOf = (o: Overlay) => (o.type === "clip" ? "원본 영상 조각" : p.assets.find((a) => a.id === o.src)?.name ?? "자료");

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
    const thr = MAGNET_PX / p.pps;

    if (d.type === "scrub") {
      p.onSeek(e0);
      return;
    }
    if (d.type === "piece") {
      if (!d.moved) {
        if (Math.abs(e.clientX - d.x0) < 4) return;
        d.moved = true;
      }
      const r = moveItem(d.base, p.speeds, d.id, e0 - d.grab, { magnet: p.magnet, threshold: thr, playhead: p.time });
      setSnapAt(r.snap);
      p.onLayout(r.items, false);
      return;
    }
    if (d.type === "ov-move") {
      const o = d.base.find((x) => x.id === d.id)!;
      if (!d.moved) {
        if (Math.abs(e.clientX - d.x0) < 4 && Math.abs(e.clientY - d.y0) < 4) return;
        d.moved = true;
      }
      const kind: Track["kind"] = o.type === "audio" ? "audio" : "video";
      const track = trackAtY(e.clientY, kind) ?? o.track;
      const want = grid(Math.max(0, e0 - d.grab));
      const sn = p.magnet ? snapStart(want, o.dur, points(o.id), thr) : { start: want, snap: null };
      const others = d.base.filter((x) => x.id !== o.id && x.track === track);
      const start = fitOnTrack(others, sn.start, o.dur);
      setSnapAt(sn.snap !== null && Math.abs(start - sn.start) < 1e-6 ? sn.snap : null);
      p.onOverlays(d.base.map((x) => (x.id === o.id ? { ...x, track, start } : x)), false);
      return;
    }
    if (d.type === "ov-l" || d.type === "ov-r") {
      const o = d.base.find((x) => x.id === d.id)!;
      const sp = p.magnet ? snapPoint(e0, points(o.id), thr) : { t: e0, snap: null };
      setSnapAt(sp.snap);
      const nb = d.base.filter((x) => x.track === o.track && x.id !== o.id);
      let t = sp.t;
      if (d.type === "ov-r") t = Math.min(t, ...nb.filter((n) => n.start >= itemEnd(o) - 1e-6).map((n) => n.start));
      else t = Math.max(t, ...nb.filter((n) => itemEnd(n) <= o.start + 1e-6).map(itemEnd), 0);
      const next = trimOverlay(o, d.type === "ov-r" ? "r" : "l", t, srcLen(o));
      p.onOverlays(d.base.map((x) => (x.id === o.id ? next : x)), false);
      return;
    }
    if (d.type === "sub-vert" || d.type === "free-move") {
      const tid = trackAtY(e.clientY, "subtitle", true);
      const cur = p.subs.find((s) => s.id === d.id);
      if (tid && cur && subTrackOf(cur) !== tid) p.onSubTrack(d.id, tid, false);
    }
    if (d.type !== "free-move" && d.type !== "free-l" && d.type !== "free-r") return;
    const dt = snap(e0) - d.t0;
    if (d.type === "free-move") p.onMoveFreeSub(d.id, Math.max(0, snap(d.o0 + dt)), Math.max(0, snap(d.o0 + dt)) + (d.o1 - d.o0), false);
    if (d.type === "free-l") p.onMoveFreeSub(d.id, clamp(snap(d.o0 + dt), 0, d.o1 - 0.1), d.o1, false);
    if (d.type === "free-r") p.onMoveFreeSub(d.id, d.o0, Math.max(d.o0 + 0.1, snap(d.o1 + dt)), false);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setSnapAt(null);
    if (d && d.type !== "scrub") p.end();
  };

  // ---------- 눈금 ----------
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * p.pps >= 70) ?? 600;
  const ticks: number[] = [];
  for (let t = Math.floor(view.left / p.pps / step) * step; t * p.pps < view.left + view.width; t += step) ticks.push(t);
  const visible = (s: number, e: number) => e * p.pps >= view.left - 50 && s * p.pps <= view.left + view.width + 50;

  const gaps = p.placed
    .map((it, i) => ({ s: i === 0 ? 0 : p.placed[i - 1].e1, e: it.atoms.length ? it.atoms[0].e0 : it.e0 }))
    .filter((g) => g.e - g.s > 1 / 30);

  const selOv = (id: string) => p.selection?.kind === "overlay" && p.selection.id === id;

  return (
    <div className="timeline arrange arr2">
      <div className="arr-heads" ref={heads}>
        <div style={{ height: RULER }} />
        {rows.map(({ t, h }) => {
          const sel = p.selection?.kind === "track" && p.selection.id === t.id;
          const off = t.kind === "audio" ? !!t.muted : !!t.hidden;
          const tag = t.id;
          return (
            <div
              key={t.id}
              className={`arr-head ${t.kind} ${sel ? "sel" : ""} ${off ? "off" : ""} ${t.locked ? "locked" : ""}`}
              style={{ height: h }}
              onClick={() => p.onSelect({ kind: "track", id: t.id })}
            >
              <b className="tid">{tag}</b>
              <span
                className="nm"
                title="더블클릭하면 이름을 바꿉니다"
                onDoubleClick={() => {
                  const n = prompt("트랙 이름", t.name);
                  if (n && n.trim()) p.onTrackPatch(t.id, { name: n.trim().slice(0, 20) });
                }}
              >
                {t.name}
              </span>
              <span className="ctl">
                {t.kind === "audio" ? (
                  <button className={t.muted ? "on" : ""} title={t.muted ? "음소거 해제" : "음소거"} onClick={(e) => { e.stopPropagation(); p.onTrackPatch(t.id, { muted: !t.muted }); }}>
                    {t.muted ? "🔇" : "🔊"}
                  </button>
                ) : (
                  !t.main && (
                    <button className={t.hidden ? "on" : ""} title={t.hidden ? "보이기" : "숨기기"} onClick={(e) => { e.stopPropagation(); p.onTrackPatch(t.id, { hidden: !t.hidden }); }}>
                      {t.hidden ? "🚫" : "👁"}
                    </button>
                  )
                )}
                <button className={t.locked ? "on" : ""} title={t.locked ? "잠금 해제" : "잠금(편집 못 하게)"} onClick={(e) => { e.stopPropagation(); p.onTrackPatch(t.id, { locked: !t.locked }); }}>
                  {t.locked ? "🔒" : "🔓"}
                </button>
              </span>
            </div>
          );
        })}
        <div style={{ height: 16 }} />
      </div>

      <div className="arr-scroll" ref={scroller} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div className="arr-content" style={{ width, height: HEIGHT }}>
          {/* 눈금 + 마커 */}
          <div
            className="tl-ruler arr-ruler"
            style={{ height: RULER, width }}
            onPointerDown={(e) => {
              capture(e);
              drag.current = { type: "scrub" };
              p.onSeek(eAt(e.clientX));
            }}
          >
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: t * p.pps }}>{fmt(t, 0)}</div>
            ))}
            {p.markers.map((m) => (
              <div
                key={m.id}
                className={`marker ${p.selection?.kind === "marker" && p.selection.id === m.id ? "sel" : ""}`}
                style={{ left: m.t * p.pps, color: m.color }}
                title={`${m.name || "마커"} · ${fmt(m.t, 2)} (클릭=이동·선택)`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  p.onSeek(m.t);
                  p.onSelect({ kind: "marker", id: m.id });
                }}
              >
                ◆<span>{m.name}</span>
              </div>
            ))}
          </div>

          {/* 트랙 행 배경 + 드롭 영역 */}
          {rows.map(({ t, top, h }) => (
            <div
              key={t.id}
              className={`arr-row ${t.kind} ${t.main ? "main" : ""} ${dropRow === t.id ? "drop" : ""} ${t.locked ? "locked" : ""}`}
              style={{ top, height: h }}
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget) return;
                p.onSeek(eAt(e.clientX));
                p.onSelect(null);
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("application/x-asset") && !t.main && t.kind !== "subtitle" && !t.locked) {
                  e.preventDefault();
                  setDropRow(t.id);
                }
              }}
              onDragLeave={() => setDropRow((r) => (r === t.id ? null : r))}
              onDrop={(e) => {
                const aid = e.dataTransfer.getData("application/x-asset");
                setDropRow(null);
                if (aid && !t.main && !t.locked) {
                  e.preventDefault();
                  p.onDropAsset(aid, t.id, eAt(e.clientX));
                }
              }}
            />
          ))}

          {/* 메인 영상: 조각 + 빈칸 */}
          {mainV && rowOf(mainV.id) && (
            <div className={`arr-layer ${mainV.locked ? "locked" : ""}`} style={{ top: rowOf(mainV.id)!.top, height: rowOf(mainV.id)!.h }}>
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
                    title={`조각 ${idx + 1} · 결과 ${fmt(it.e0, 2)} ~ ${fmt(it.e1, 2)}\n원본 ${fmt(it.a, 2)} ~ ${fmt(it.b, 2)}\n끌어서 옮기기 · 우클릭 = 메뉴`}
                    onPointerDown={(e) => {
                      if (mainV.locked || e.button !== 0) return;
                      e.stopPropagation();
                      e.preventDefault();
                      capture(e);
                      p.onSelect({ kind: "piece", id: it.id });
                      p.onSeek(eAt(e.clientX));
                      p.begin();
                      drag.current = { type: "piece", id: it.id, grab: eAt(e.clientX) - it.e0, base: p.items, moved: false, x0: e.clientX };
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      p.onSelect({ kind: "piece", id: it.id });
                      p.onPieceMenu(it.id, e.clientX, e.clientY);
                    }}
                  >
                    <b>{idx + 1}</b>
                    <span>{(it.e1 - it.e0).toFixed(1)}초</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* 메인 음성: 파형 */}
          {mainA && rowOf(mainA.id) && (
            <div className={`arr-layer arr-wave ${mainA.muted ? "off" : ""}`} style={{ top: rowOf(mainA.id)!.top, height: rowOf(mainA.id)!.h, pointerEvents: "none" }}>
              <canvas ref={canvas} style={{ left: view.left, width: view.width, height: rowOf(mainA.id)!.h }} />
            </div>
          )}

          {/* 추가 영상·음성 레이어의 항목 */}
          {p.overlays.map((o) => {
            const r = rowOf(o.track);
            if (!r || !visible(o.start, itemEnd(o))) return null;
            const t = r.t;
            const off = t.kind === "audio" ? !!t.muted : !!t.hidden;
            return (
              <div
                key={o.id}
                className={`ov ${o.type} ${selOv(o.id) ? "sel" : ""} ${off ? "off" : ""} ${t.locked ? "locked" : ""}`}
                style={{ top: r.top + 3, height: r.h - 6, left: o.start * p.pps, width: Math.max(4, o.dur * p.pps) }}
                title={`${nameOf(o)}\n${fmt(o.start, 2)} ~ ${fmt(itemEnd(o), 2)} (${o.dur.toFixed(1)}초)\n끌어서 이동 · 가장자리를 끌어 길이 조절 · 우클릭 = 메뉴`}
                onPointerDown={(e) => {
                  if (t.locked || e.button !== 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  capture(e);
                  p.onSelect({ kind: "overlay", id: o.id });
                  p.begin();
                  drag.current = { type: "ov-move", id: o.id, grab: eAt(e.clientX) - o.start, base: p.overlays, moved: false, x0: e.clientX, y0: e.clientY };
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  p.onSelect({ kind: "overlay", id: o.id });
                  p.onOverlayMenu(o.id, e.clientX, e.clientY);
                }}
              >
                <span>{OV_ICON[o.type]} {nameOf(o)}</span>
                {o.fade_in > 0 && <i className="fade in" style={{ width: o.fade_in * p.pps }} />}
                {o.fade_out > 0 && <i className="fade out" style={{ width: o.fade_out * p.pps }} />}
                {!t.locked && (
                  <>
                    <div className="h l" onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); capture(e); p.onSelect({ kind: "overlay", id: o.id }); p.begin(); drag.current = { type: "ov-l", id: o.id, base: p.overlays }; }} />
                    <div className="h r" onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); capture(e); p.onSelect({ kind: "overlay", id: o.id }); p.begin(); drag.current = { type: "ov-r", id: o.id, base: p.overlays }; }} />
                  </>
                )}
              </div>
            );
          })}

          {/* 자막: 레이어(트랙)별 줄 */}
          {p.subs.filter((s) => visible(s.e0, s.e1)).map((s, i) => {
            const r = rowOf(subTrackOf(s));
            if (!r) return null;
            const sel = (p.selection?.kind === "sub" && p.selection.id === s.id) || p.multiSubs.includes(s.id);
            const locked = r.t.locked;
            return (
              <div
                key={`${s.id}-${i}`}
                className={`sub arr-sub ${sel ? "sel" : ""} ${s.free ? "free" : ""} ${r.t.hidden ? "off" : ""}`}
                style={{ top: r.top + 3, height: r.h - 6, left: s.e0 * p.pps, width: Math.max(2, (s.e1 - s.e0) * p.pps) }}
                title={`${s.text}\n${fmt(s.e0, 2)} ~ ${fmt(s.e1, 2)}\n${s.free ? "분리된 자막 (끌어서 이동)" : "조각을 따라 이동 (우클릭 → 그룹 해제로 분리)"} · 위아래로 끌면 다른 자막 레이어로 이동`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  p.onSelect({ kind: "sub", id: s.id }, e.ctrlKey || e.metaKey);
                  if (locked || e.ctrlKey || e.metaKey || e.button !== 0) return;
                  e.preventDefault();
                  capture(e);
                  p.begin();
                  drag.current = s.free
                    ? { type: "free-move", id: s.id, t0: snap(eAt(e.clientX)), o0: s.e0, o1: s.e1 }
                    : { type: "sub-vert", id: s.id };
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  p.onSubMenu(s.id, e.clientX, e.clientY);
                }}
              >
                <span>{s.free ? "🔓 " : ""}{s.text}</span>
                {s.free && !locked && (
                  <>
                    <div className="h l" onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); capture(e); p.begin(); drag.current = { type: "free-l", id: s.id, t0: snap(eAt(e.clientX)), o0: s.e0, o1: s.e1 }; }} />
                    <div className="h r" onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); capture(e); p.begin(); drag.current = { type: "free-r", id: s.id, t0: snap(eAt(e.clientX)), o0: s.e0, o1: s.e1 }; }} />
                  </>
                )}
              </div>
            );
          })}

          {snapAt !== null && <div className="snap-line" style={{ left: snapAt * p.pps, height: HEIGHT }} />}
          <div className="playhead" style={{ left: p.time * p.pps, height: HEIGHT }} />
        </div>
      </div>
    </div>
  );
}
