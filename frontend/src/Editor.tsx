import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Asset, type Cut, type Group, type Project, type SilenceParams, type Subtitle } from "./api";
import ExportDialog from "./ExportDialog";
import Inspector, { type EditDoc } from "./Inspector";
import Timeline, { newCut, newSub, type Doc, type Selection } from "./Timeline";
import { useHistory } from "./useHistory";
import VideoPreview, { type PreviewSub } from "./VideoPreview";
import ArrangeTimeline, { type ArrangeSelection } from "./ArrangeTimeline";
import LayerStage from "./LayerStage";
import { defaultTracks, editPoints, nextPoint, ofKind, prevPoint, totalWithLayers } from "./layers";
import { useLayerActions } from "./useLayerActions";
import { isDefaultLayout, moveItem, placeItems, pToE, eToP, reconcile, setGap, subInstances, type Item } from "./layout";
import { adjacentCut, computePieces, edgeKind, reviveRange, type Piece } from "./pieces";
import { clamp, fmt, snap, uid } from "./time";
import { useArrangePlayback } from "./useArrangePlayback";

type SaveState = "saved" | "pending" | "saving" | "error";

/** 겹치는 컷을 합친 '실제로 잘릴 구간' 목록 */
function mergedCuts(cuts: Cut[]): [number, number][] {
  const on = cuts.filter((c) => c.enabled).map((c) => [c.start, c.end] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of on) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1e-6) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

interface EditorProps {
  project: Project;
  onBack: () => void;
  onReload: () => void; // 클립 순서가 바뀌어 미리보기를 다시 만들 때 상태를 새로 불러온다
  onFinished: () => void; // 완료 처리 후
}

const sameItems = (x: Item[], y: Item[]) =>
  x.length === y.length && x.every((a, i) => a.id === y[i].id && Math.abs(a.a - y[i].a) < 1e-6 && Math.abs(a.b - y[i].b) < 1e-6 && Math.abs(a.gap - y[i].gap) < 1e-6);

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export default function Editor({ project, onBack, onReload, onFinished }: EditorProps) {
  // 컷·나눈 지점이 바뀔 때마다 결과 배치(조각 순서·빈칸)를 새 조각에 맞춘다
  const normalize = (d: EditDoc): EditDoc => {
    const k = computePieces(project.duration, d.cuts, d.splits, project.clips.slice(1).map((c) => c.offset)).map((x) => ({ a: x.start, b: x.end }));
    const next = reconcile(d.layout, k);
    return sameItems(next, d.layout) ? d : { ...d, layout: next };
  };
  const hist = useHistory<EditDoc>(
    {
      cuts: project.cuts, subtitles: project.subtitles, speeds: project.speed_ranges ?? [], splits: project.splits ?? [], layout: project.layout ?? [],
      tracks: project.tracks?.length ? project.tracks : defaultTracks(), overlays: project.overlays ?? [], markers: project.markers ?? [], style: project.style,
    },
    normalize,
  );
  const doc = hist.present;
  const payload = (d: EditDoc) => ({ ...d, layout: isDefaultLayout(d.layout) ? [] : d.layout });
  const [meta, setMeta] = useState(project); // 클립 분석값·무음 설정 등 (재감지 시 갱신)
  const [wave, setWave] = useState<{ frame_sec: number; db: number[] } | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [skipCuts, setSkipCuts] = useState(true);
  const [applySpeed, setApplySpeed] = useState(true);
  const [pps, setPps] = useState(40);
  const [save, setSave] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<string>(project.updated ? project.updated.slice(11, 16) : "");
  const [groups, setGroups] = useState<Group[]>(project.groups ?? []);
  const [selectedClips, setSelectedClips] = useState<string[]>([]);
  const [finishing, setFinishing] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [exporting, setExporting] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  const cutsMerged = useMemo(() => mergedCuts(doc.cuts), [doc.cuts]);
  const removed = cutsMerged.reduce((a, [s, e]) => a + (e - s), 0);
  const { placed, total: mainTotal } = useMemo(() => placeItems(doc.layout, doc.speeds), [doc.layout, doc.speeds]);
  const total = useMemo(() => totalWithLayers(mainTotal, doc.tracks, doc.overlays), [mainTotal, doc.tracks, doc.overlays]); // 레이어가 더 길면 그만큼 늘어난다
  const resultDuration = total;
  const [assets, setAssets] = useState<Asset[]>(project.assets ?? []);
  const [assetBusy, setAssetBusy] = useState("");
  const [assetError, setAssetError] = useState("");
  const layoutIsDefault = isDefaultLayout(doc.layout);
  const pieces = useMemo<Piece[]>(
    () => [...doc.layout].sort((x, y) => x.a - y.a).map((i) => ({ id: i.id, start: i.a, end: i.b })),
    [doc.layout],
  );
  const [view, setView] = useState<"source" | "arrange">("source");
  const viewRef = useRef(view);
  viewRef.current = view;
  const [magnet, setMagnet] = useState(true);
  const [ppsE, setPpsE] = useState(40);
  const [multiSubs, setMultiSubs] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const arrange = useArrangePlayback(video, placed, total, view === "arrange");
  // 메인에서 빼서 위 레이어로 올린 조각은 그 구간의 자막을 함께 가져간다
  const carried = useMemo(() => {
    const hidden = new Set(doc.tracks.filter((t) => t.hidden).map((t) => t.id));
    return doc.overlays
      .filter((o) => o.type === "clip" && o.carry_subs && !hidden.has(o.track))
      .flatMap((o) => {
        const c = project.clips.find((x) => x.id === o.src);
        return c ? [{ a: c.offset + o.src_in, b: c.offset + o.src_in + o.dur, e0: o.start, e1: o.start + o.dur }] : [];
      });
  }, [doc.overlays, doc.tracks, project.clips]);
  const subInst = useMemo(() => subInstances(placed, doc.subtitles, carried), [placed, doc.subtitles, carried]);
  const subTracks = useMemo(() => ofKind(doc.tracks, "subtitle"), [doc.tracks]);
  /** 자막이 속한 레이어(없거나 지워졌으면 맨 아래 자막 레이어)에 맞는 스타일·그리는 순서 */
  const previewSub = useCallback((key: string, text: string, track?: string): PreviewSub | null => {
    const tr = subTracks.find((x) => x.id === track) ?? subTracks[subTracks.length - 1];
    if (!tr || tr.hidden) return null;
    return { id: key, text, style: { ...doc.style, ...(tr.style ?? {}) }, z: subTracks.length - subTracks.indexOf(tr) };
  }, [subTracks, doc.style]);
  const arrangeSubs = useMemo(
    () => subInst.filter((i) => arrange.time >= i.e0 && arrange.time < i.e1).map((i) => previewSub(`${i.id}-${i.e0}`, i.text, i.track)).filter((x): x is PreviewSub => !!x),
    [subInst, arrange.time, previewSub],
  );
  const curSpeed = doc.speeds.find((r) => time >= r.start && time < r.end)?.speed ?? 1;
  const inCut = cutsMerged.find(([s, e]) => time >= s && time < e);
  const sourceSubs = doc.subtitles.filter((s) => !s.free && time >= s.start && time < s.end).map((s) => previewSub(s.id, s.text, s.track)).filter((x): x is PreviewSub => !!x);

  // 메인 음성(A1)의 볼륨·음소거는 메인 영상의 소리에 반영한다
  const mainAudio = doc.tracks.find((x) => x.kind === "audio" && x.main);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = !!mainAudio?.muted;
    v.volume = Math.max(0, Math.min(1, mainAudio?.volume ?? 1));
  }, [mainAudio?.muted, mainAudio?.volume]);

  useEffect(() => {
    api.waveform(project.id).then(setWave).catch(() => setWave(null));
  }, [project.id]);

  // ---------- 자동 저장 (변경 0.8초 뒤) ----------
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSave("pending");
    const timer = setTimeout(async () => {
      setSave("saving");
      try {
        await api.saveEdits(project.id, payload(doc));
        setSave("saved");
        setSavedAt(hhmm(new Date()));
        setSaveErr("");
      } catch (e) {
        setSave("error");
        setSaveErr((e as Error).message);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [doc, project.id]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (save !== "saved") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save]);

  // ---------- 재생: 재생 위치 추적 + 컷 건너뛰기 ----------
  const cutsRef = useRef(cutsMerged);
  cutsRef.current = cutsMerged;
  const skipRef = useRef(skipCuts);
  skipRef.current = skipCuts;
  const speedsRef = useRef(doc.speeds);
  speedsRef.current = doc.speeds;
  const applySpeedRef = useRef(applySpeed);
  applySpeedRef.current = applySpeed;
  useEffect(() => {
    const v = video.current!;
    let timer = 0;
    // 재생 중에만 25ms마다 확인한다(정지 상태에서는 이벤트로만 갱신).
    // requestAnimationFrame은 창이 가려지면 멈춰서 컷 건너뛰기를 놓칠 수 있어 타이머를 쓴다.
    const tick = () => {
      if (viewRef.current !== "source") return;
      let t = v.currentTime;
      if (skipRef.current) {
        const hit = cutsRef.current.find(([s, e]) => t >= s && t < e - 0.02);
        if (hit) {
          v.currentTime = hit[1];
          t = hit[1];
        }
      }
      // 배속 구간 안에서는 재생 속도를 바꿔 미리 볼 수 있다(음성 높낮이는 브라우저가 유지)
      const sp = applySpeedRef.current ? speedsRef.current.find((r) => t >= r.start && t < r.end)?.speed ?? 1 : 1;
      if (v.playbackRate !== sp) v.playbackRate = sp;
      setTime(t);
    };
    const onPlay = () => {
      if (viewRef.current !== "source") return;
      setPlaying(true);
      clearInterval(timer);
      timer = window.setInterval(tick, 25);
    };
    const onStop = () => {
      if (viewRef.current !== "source") return;
      setPlaying(false);
      clearInterval(timer);
      setTime(v.currentTime);
    };
    const onSeek = () => {
      if (viewRef.current === "source") setTime(v.currentTime);
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onStop);
    v.addEventListener("ended", onStop);
    v.addEventListener("seeking", onSeek);
    v.addEventListener("seeked", onSeek);
    return () => {
      clearInterval(timer);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onStop);
      v.removeEventListener("ended", onStop);
      v.removeEventListener("seeking", onSeek);
      v.removeEventListener("seeked", onSeek);
    };
  }, []);

  const seek = useCallback((t: number) => {
    const v = video.current;
    if (v) v.currentTime = clamp(t, 0, project.duration);
  }, [project.duration]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const playFrom = useCallback((t: number) => {
    if (viewRef.current === "arrange") {
      arrange.seek(t); // 결과 배치 보기에서는 결과 시간
      arrange.play();
      return;
    }
    seek(t);
    video.current?.play();
  }, [seek, arrange.seek, arrange.play]);

  const togglePlayAny = useCallback(() => (viewRef.current === "arrange" ? arrange.toggle() : togglePlay()), [arrange.toggle, togglePlay]);

  // ---------- 보기 전환 (원본 기준 ↔ 결과 배치) ----------
  const switchView = (v: "source" | "arrange") => {
    if (v === view) return;
    video.current?.pause();
    if (video.current) video.current.playbackRate = 1;
    if (v === "arrange") {
      const e = pToE(placed, time) ?? 0;
      setView(v);
      viewRef.current = v;
      arrange.seek(e);
      if (selection && selection.kind !== "piece" && selection.kind !== "sub") setSelection(null);
    } else {
      const hit = eToP(placed, arrange.time);
      setView(v);
      viewRef.current = v;
      if (hit) seek(hit.p);
    }
  };

  // ---------- 결과 배치 편집 ----------
  const setLayout = useCallback((items: Item[], record: boolean) => hist.set((d) => ({ ...d, layout: items }), record), [hist.set]);

  const movePieceTo = (id: string, startE: number) => {
    const r = moveItem(doc.layout, doc.speeds, id, startE, { magnet: false, threshold: 0 });
    setLayout(r.items, true);
  };

  const setPieceGap = (id: string, gap: number) => setLayout(setGap(doc.layout, id, gap), true);

  const resetLayout = () => {
    if (!confirm("조각 순서와 빈칸을 처음 상태(원본 순서, 빈칸 없음)로 되돌립니다. 진행할까요?")) return;
    hist.set((d) => ({ ...d, layout: [...d.layout].sort((x, y) => x.a - y.a).map((i) => ({ ...i, gap: 0 })) }));
  };

  const moveFreeSub = useCallback((id: string, e0: number, e1: number, record: boolean) =>
    hist.set((d) => ({ ...d, subtitles: d.subtitles.map((s) => (s.id === id ? { ...s, e_start: e0, e_end: e1 } : s)) }), record), [hist.set]);

  const subRange = (id: string): [number, number] | null => {
    const xs = subInst.filter((i) => i.id === id);
    return xs.length ? [Math.min(...xs.map((i) => i.e0)), Math.max(...xs.map((i) => i.e1))] : null;
  };

  /** 우클릭 → 그룹 해제: 조각을 따라가던 자막을 지금 결과 위치에 고정한다 */
  const detachSub = (id: string) => {
    const r = subRange(id);
    if (!r) return;
    hist.set((d) => ({ ...d, subtitles: d.subtitles.map((s) => (s.id === id ? { ...s, free: true, e_start: r[0], e_end: r[1] } : s)) }));
  };

  /** 분리된 자막을 그 시간에 놓인 조각에 다시 붙인다 */
  const attachSub = (id: string) => {
    const s = doc.subtitles.find((x) => x.id === id);
    if (!s || s.e_start == null || s.e_end == null) return;
    const a = eToP(placed, s.e_start + 1e-3) ?? placed.map((it) => ({ item: it, p: it.a })).find((h) => placed[placed.indexOf(h.item)].e0 >= (s.e_start ?? 0)) ?? null;
    const b = eToP(placed, s.e_end - 1e-3);
    if (!a) {
      alert("이 자막이 놓인 자리에 조각이 없어 붙일 수 없습니다. 조각 위로 옮긴 뒤 다시 시도해 주세요.");
      return;
    }
    const start = snap(a.p);
    const end = snap(b && b.item === a.item ? b.p : Math.min(a.item.b, start + (s.e_end - s.e_start)));
    hist.set((d) => ({
      ...d,
      subtitles: d.subtitles.map((x) => {
        if (x.id !== id) return x;
        const { free: _f, e_start: _s, e_end: _e, ...rest } = x;
        return { ...rest, start, end: Math.max(end, start + 0.1) };
      }),
    }));
  };

  /** 선택한 자막 여러 개를 하나로 합친다(문장을 이어 붙임) */
  const mergeSubs = (ids: string[]) => {
    const picked = ids
      .map((id) => ({ s: doc.subtitles.find((x) => x.id === id), r: subRange(id) ?? (() => { const f = doc.subtitles.find((x) => x.id === id); return f?.e_start != null && f.e_end != null ? ([f.e_start, f.e_end] as [number, number]) : null; })() }))
      .filter((x): x is { s: Subtitle; r: [number, number] } => !!x.s && !!x.r)
      .sort((x, y) => x.r[0] - y.r[0]);
    if (picked.length < 2) return;
    const first = picked[0].s;
    const e0 = Math.min(...picked.map((x) => x.r[0]));
    const e1 = Math.max(...picked.map((x) => x.r[1]));
    const text = picked.map((x) => x.s.text.trim()).filter(Boolean).join(" ");
    const keep = new Set(picked.map((x) => x.s.id));
    hist.set((d) => ({
      ...d,
      subtitles: d.subtitles
        .filter((x) => !keep.has(x.id) || x.id === first.id)
        .map((x) => (x.id === first.id ? { ...x, text, words: [], needs_review: false, review_reasons: [], free: true, e_start: e0, e_end: e1 } : x)),
    }));
    setSelection({ kind: "sub", id: first.id });
    setMultiSubs([]);
  };

  const playheadE = () => (viewRef.current === "arrange" ? arrange.time : pToE(placed, time) ?? 0);
  const [pmenu, setPmenu] = useState<{ kind: "piece" | "overlay"; id: string; x: number; y: number } | null>(null);
  const actions = useLayerActions({
    doc, set: hist.set, placed, assets, clips: project.clips, playheadE,
    select: (s) => setSelection(s), notify: (m) => alert(m),
  });

  const uploadAssets = async (files: FileList | File[]) => {
    setAssetError("");
    for (const f of Array.from(files)) {
      setAssetBusy(`'${f.name}' 처리하는 중… (영상은 미리보기 사본을 만드느라 시간이 걸릴 수 있습니다)`);
      try {
        const a = await api.uploadAsset(project.id, f);
        setAssets((prev) => [...prev, a]);
      } catch (e) {
        setAssetError(`${f.name}: ${(e as Error).message}`);
      }
    }
    setAssetBusy("");
  };

  const removeAsset = async (a: Asset) => {
    if (!confirm(`'${a.name}' 자료를 지울까요?`)) return;
    try {
      await api.removeAsset(project.id, a.id);
      setAssets((prev) => prev.filter((x) => x.id !== a.id));
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const onArrangeSelect = (s: ArrangeSelection, additive?: boolean) => {
    if (s?.kind === "sub" && additive) {
      setMultiSubs((prev) => {
        const base = prev.length || !selection || selection.kind !== "sub" ? prev : [selection.id];
        return base.includes(s.id) ? base.filter((x) => x !== s.id) : [...base, s.id];
      });
      return;
    }
    setMultiSubs([]);
    setSelection(s);
    if (s?.kind === "piece" && video.current) video.current.pause();
  };

  // ---------- 편집 동작 ----------
  const updateTimeline = useCallback(
    (fn: (d: Doc) => Doc, record = true) => hist.set((prev) => ({ ...prev, ...fn(prev) }), record),
    [hist.set],
  );

  const deletePiece = useCallback((pc: Piece) => {
    const id = uid("cut");
    hist.set((d) => ({ ...d, cuts: [...d.cuts, newCut(id, pc.start, pc.end)] }));
    setSelection(null);
  }, [hist.set]);

  const splitAtPlayhead = () => {
    if (viewRef.current === "arrange" && selection?.kind === "overlay" && actions.splitSelected(selection.id, arrange.time)) return;
    let src = video.current?.currentTime ?? time;
    if (viewRef.current === "arrange") {
      const hit = eToP(placed, arrange.time);
      if (!hit) {
        alert("빈칸에서는 나눌 수 없습니다. 조각 안으로 재생 위치를 옮긴 뒤 다시 눌러 주세요.");
        return;
      }
      src = hit.p;
    }
    const t = snap(src);
    const f = 1 / 30 - 1e-4;
    const inside = pieces.find((pc) => t - pc.start >= f && pc.end - t >= f);
    if (!inside) {
      alert("이 위치에서는 나눌 수 없습니다. 잘릴 구간이거나 조각 가장자리에서 1프레임 이내입니다. 남는 구간 안으로 재생 위치를 옮긴 뒤 다시 눌러 주세요.");
      return;
    }
    hist.set((d) => ({ ...d, splits: [...d.splits, t].sort((a, b) => a - b) }));
    setSelection({ kind: "piece", id: inside.id });
  };
  const splitRef = useRef(splitAtPlayhead);
  splitRef.current = splitAtPlayhead;

  const rejoin = (pc: Piece, side: "l" | "r") => {
    const kind = edgeKind(side, pc, doc.cuts, doc.splits);
    const edge = side === "l" ? pc.start : pc.end;
    if (kind === "split") {
      hist.set((d) => ({ ...d, splits: d.splits.filter((s) => Math.abs(s - edge) > 1e-4) }));
    } else if (kind === "cut") {
      const r = adjacentCut(side, pc, doc.cuts);
      if (r) hist.set((d) => ({ ...d, cuts: reviveRange(d.cuts, r[0], r[1], () => uid("cut")) }));
    }
    setSelection(null);
  };

  const deleteSelected = useCallback(() => {
    if (!selection) return;
    if (selection.kind === "piece") {
      const pc = pieces.find((x) => x.id === selection.id);
      if (pc) deletePiece(pc);
      return;
    }
    if (selection.kind === "overlay") return actions.deleteOverlay(selection.id);
    if (selection.kind === "marker") return actions.deleteMarker(selection.id);
    if (selection.kind === "track") return;
    hist.set((d) =>
      selection.kind === "cut"
        ? { ...d, cuts: d.cuts.filter((c) => c.id !== selection.id) }
        : selection.kind === "speed"
          ? { ...d, speeds: d.speeds.filter((r) => r.id !== selection.id) }
          : { ...d, subtitles: d.subtitles.filter((s) => s.id !== selection.id) },
    );
    setSelection(null);
  }, [selection, hist.set, pieces, deletePiece, actions.deleteOverlay, actions.deleteMarker]);

  const addCut = () => {
    const t = snap(time);
    const id = uid("cut");
    hist.set((d) => ({ ...d, cuts: [...d.cuts, newCut(id, t, Math.min(t + 1, project.duration))] }));
    setSelection({ kind: "cut", id });
  };

  const addSpeed = () => {
    const t = snap(time);
    const next = doc.speeds.filter((r) => r.start > t).map((r) => r.start);
    const inside = doc.speeds.some((r) => t >= r.start && t < r.end);
    const end = snap(Math.min(t + 5, project.duration, ...next));
    if (inside || end - t < 0.3) {
      alert("이 위치에는 이미 배속 구간이 있거나 공간이 부족합니다. 빈 곳으로 이동한 뒤 추가하세요.");
      return;
    }
    const id = uid("spd");
    hist.set((d) => ({ ...d, speeds: [...d.speeds, { id, start: t, end, speed: 1.5 }] }));
    setSelection({ kind: "speed", id });
  };

  const addSub = () => {
    const t = snap(time);
    const next = doc.subtitles.filter((s) => s.start > t).map((s) => s.start);
    const inside = doc.subtitles.some((s) => t >= s.start && t < s.end);
    const end = Math.min(t + 2, project.duration, ...next);
    if (inside || end - t < 0.3) {
      alert("이 위치에는 이미 자막이 있거나 공간이 부족합니다. 빈 곳으로 이동한 뒤 추가하세요.");
      return;
    }
    const id = uid("sub");
    hist.set((d) => ({ ...d, subtitles: [...d.subtitles, newSub(id, t, end)].sort((a, b) => a.start - b.start) }));
    setSelection({ kind: "sub", id });
  };

  const redetect = async (params: SilenceParams) => {
    const p = await api.redetect(project.id, params);
    setMeta(p);
    hist.replace({ ...doc, cuts: p.cuts });
  };

  // ---------- 단축키 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) hist.redo();
        else hist.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        hist.redo();
        return;
      }
      if (typing) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlayAny();
      } else if (e.key.toLowerCase() === "n" && !mod && viewRef.current === "arrange") {
        e.preventDefault();
        setMagnet((v) => !v);
      } else if (e.key.toLowerCase() === "m" && !mod && viewRef.current === "arrange") {
        e.preventDefault();
        actions.addMarker(arrange.time);
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && viewRef.current === "arrange") {
        e.preventDefault();
        const pts = editPoints(placed.flatMap((p) => [p.e0, p.e1]), doc.overlays, doc.markers);
        const go = e.key === "ArrowUp" ? prevPoint(pts, arrange.time) : nextPoint(pts, arrange.time);
        if (go !== null) arrange.seek(go);
      } else if (e.key.toLowerCase() === "s" && !mod) {
        e.preventDefault();
        splitRef.current();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 / 30 : 1);
        if (viewRef.current === "arrange") arrange.seek(arrange.time + d);
        else seek((video.current?.currentTime ?? 0) + d);
      } else if (e.key === "Escape") {
        setSelection(null);
        setMultiSubs([]);
        setMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hist.undo, hist.redo, togglePlayAny, deleteSelected, seek, arrange.seek, arrange.time, placed, doc.overlays, doc.markers, actions.addMarker]);

  const fitAll = () => {
    const w = document.querySelector(".tl-scroll")?.clientWidth ?? 1000;
    if (view === "arrange") setPpsE(clamp((w - 20) / Math.max(total + 2, 5), 2, 600));
    else setPps(clamp((w - 20) / project.duration, 2, 600));
  };

  const saveLabel = {
    saved: savedAt ? `임시저장됨 ${savedAt}` : "임시저장됨",
    pending: "변경됨…",
    saving: "저장 중…",
    error: "저장 실패",
  }[save];

  /** 편집 내용을 즉시 서버에 저장(임시저장 버튼, 내보내기·순서 변경 전) */
  const flush = useCallback(async () => {
    setSave("saving");
    try {
      await api.saveEdits(project.id, payload(doc));
      setSave("saved");
      setSavedAt(hhmm(new Date()));
      setSaveErr("");
    } catch (e) {
      setSave("error");
      setSaveErr((e as Error).message);
      throw e;
    }
  }, [project.id, doc]);

  // ---------- 클립 순서·그룹 ----------
  const applyOrder = async (order: string[], nextGroups: Group[]) => {
    const changed = order.join() !== project.clips.map((c) => c.id).join();
    if (changed) {
      const sec = Math.max(5, Math.round(project.duration * 0.1));
      if (!confirm(`클립 순서를 바꿉니다. 각 클립의 컷과 자막도 함께 옮겨집니다.
미리보기 영상을 다시 만드는 데 약 ${sec}초 걸립니다. 진행할까요?`)) return;
    }
    video.current?.pause();
    try {
      await flush();
      const p = await api.reorder(project.id, order, nextGroups);
      setGroups(p.groups ?? []);
      if (changed) onReload();
    } catch (e) {
      alert(`순서/그룹을 바꾸지 못했습니다: ${(e as Error).message}`);
    }
  };

  const makeGroup = () => {
    if (selectedClips.length < 2) return;
    const order = project.clips.map((c) => c.id);
    // 이미 그룹에 속한 클립을 고르면 그 그룹 전체를 새 그룹에 합친다
    const touched = groups.filter((g) => g.clips.some((c) => selectedClips.includes(c)));
    const members = new Set([...selectedClips, ...touched.flatMap((g) => g.clips)]);
    const first = order.findIndex((id) => members.has(id));
    const rest = order.filter((id) => !members.has(id));
    const inGroup = order.filter((id) => members.has(id));
    const before = rest.filter((id) => order.indexOf(id) < first);
    const after = rest.filter((id) => order.indexOf(id) > first);
    const newOrder = [...before, ...inGroup, ...after];
    const name = prompt("그룹 이름을 입력하세요 (예: 거실, 주방)", `그룹 ${groups.length + 1}`);
    if (name === null) return;
    const next = [...groups.filter((g) => !touched.includes(g)), { id: `g${Date.now().toString(36)}`, name: name || `그룹 ${groups.length + 1}`, clips: inGroup }];
    applyOrder(newOrder, next);
  };

  const ungroup = () => {
    const next = groups.filter((g) => !g.clips.some((c) => selectedClips.includes(c)));
    applyOrder(project.clips.map((c) => c.id), next);
  };

  const renameGroup = (id: string) => {
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    const name = prompt("그룹 이름", g.name);
    if (!name) return;
    applyOrder(project.clips.map((c) => c.id), groups.map((x) => (x.id === id ? { ...x, name } : x)));
  };

  return (
    <div className="editor-page">
      <header className="topbar">
        <button className="link" onClick={onBack}>← 프로젝트 목록</button>
        <h1>{project.name}</h1>
        <span className={`save ${save}`} title={saveErr || "편집 내용은 자동으로도 저장됩니다"}>{saveLabel}{save === "error" ? ` — ${saveErr}` : ""}</span>
        <div className="spacer" />
        <button onClick={hist.undo} disabled={!hist.canUndo} title="Ctrl+Z">↶ 되돌리기</button>
        <button onClick={hist.redo} disabled={!hist.canRedo} title="Ctrl+Shift+Z">↷ 다시하기</button>
        <button onClick={() => flush().catch(() => {})} title="지금 상태를 저장합니다. 첫 화면 '작업 중' 목록에서 언제든 이어서 할 수 있습니다.">💾 임시저장</button>
        <button onClick={() => { video.current?.pause(); setExporting(true); }} title="작업은 그대로 두고 결과 영상만 뽑아 봅니다">내보내기</button>
        <button className="primary" onClick={() => { video.current?.pause(); setFinishing(true); }} title="최종 파일을 만들고 작업을 마칩니다">✔ 완료</button>
      </header>

      <div className="main">
        <section className="player">
          <VideoPreview
            ref={video}
            src={api.proxyUrl(project.id, project.proxy)}
            aspect={project.output.width / project.output.height}
            subs={view === "arrange" ? arrangeSubs : sourceSubs}
            inCut={view === "source" && !!inCut && !skipCuts}
            speed={view === "source" && applySpeed ? curSpeed : 1}
            blank={view === "arrange" && arrange.blank}
            blankLabel={!doc.overlays.some((o) => arrange.time >= o.start && arrange.time < o.start + o.dur && o.type !== "audio")}
            layers={view === "arrange" ? (rect) => (
              <LayerStage
                rect={rect} time={arrange.time} playing={arrange.playing} projectId={project.id}
                proxySrc={api.proxyUrl(project.id, project.proxy)} tracks={doc.tracks} overlays={doc.overlays} assets={assets} clips={project.clips}
              />
            ) : undefined}
            onClick={togglePlayAny}
          />
          <div className="controls">
            <button className="play" onClick={togglePlayAny}>{(view === "arrange" ? arrange.playing : playing) ? "❚❚" : "▶"}</button>
            <span className="clock">
              {view === "arrange" ? `${fmt(arrange.time, 2)} / ${fmt(total, 1)}` : `${fmt(time, 2)} / ${fmt(project.duration, 1)}`}
            </span>
            <button onClick={splitAtPlayhead} title="재생 위치를 1프레임 단위로 나눕니다 (S)">✂ 여기서 나누기</button>
            {view === "source" && (
              <label className="check">
                <input type="checkbox" checked={skipCuts} onChange={(e) => setSkipCuts(e.target.checked)} />
                컷 적용해서 보기 (잘릴 구간 건너뛰기)
              </label>
            )}
            {view === "source" && doc.speeds.length > 0 && (
              <label className="check">
                <input type="checkbox" checked={applySpeed} onChange={(e) => { setApplySpeed(e.target.checked); if (!e.target.checked && video.current) video.current.playbackRate = 1; }} />
                배속 적용해서 보기
              </label>
            )}
            <span className="result">결과 길이 <b>{fmt(resultDuration)}</b> ({removed.toFixed(1)}초 제거{doc.speeds.length ? " · 배속 반영" : ""}{layoutIsDefault ? "" : " · 배치 반영"}{doc.overlays.length ? " · 레이어 반영" : ""})</span>
          </div>
        </section>
        <Inspector
          doc={doc}
          duration={project.duration}
          resultDuration={resultDuration}
          clips={meta.clips}
          analysis={meta.clip_analysis}
          silence={meta.silence_params}
          selection={selection}
          time={view === "arrange" ? arrange.time : time}
          update={(fn, record) => hist.set(fn, record)}
          view={view}
          placed={placed}
          onMovePiece={movePieceTo}
          onSetGap={setPieceGap}
          onResetLayout={resetLayout}
          layoutIsDefault={layoutIsDefault}
          begin={hist.begin}
          end={hist.end}
          onSelect={setSelection}
          onPlayFrom={playFrom}
          onAddCut={addCut}
          onAddSub={addSub}
          onAddSpeed={addSpeed}
          pieces={pieces}
          onSplit={splitAtPlayhead}
          onDeletePiece={deletePiece}
          onRejoin={rejoin}
          requestNotes={project.request?.unsupported ?? []}
          projectId={project.id}
          assets={assets}
          actions={actions}
          seekE={(e) => (viewRef.current === "arrange" ? arrange.seek(e) : undefined)}
          assetBusy={assetBusy}
          assetError={assetError}
          onUploadAssets={uploadAssets}
          onRemoveAsset={removeAsset}
          onRedetect={redetect}
        />
      </div>

      {(exporting || finishing) && (
        <ExportDialog
          mode={finishing ? "finish" : "export"}
          onFinished={onFinished}
          projectId={project.id}
          resultDuration={resultDuration}
          cutCount={cutsMerged.length}
          subCount={doc.subtitles.length}
          reviewLeft={doc.cuts.filter((c) => c.needs_review && c.enabled).length + doc.subtitles.filter((s) => s.needs_review).length}
          flush={flush}
          onClose={() => { setExporting(false); setFinishing(false); }}
        />
      )}

      <div className="tl-bar">
        <span className="view-switch" role="group" aria-label="타임라인 보기">
          <button className={view === "source" ? "on" : ""} onClick={() => switchView("source")} title="원본 순서대로 보면서 컷·자막·배속을 편집합니다">원본 기준 (컷 편집)</button>
          <button className={view === "arrange" ? "on" : ""} onClick={() => switchView("arrange")} title="결과 영상 순서로 보면서 조각을 끌어 옮기고 빈칸을 둡니다">결과 배치</button>
        </span>
        <span>확대</span>
        <input type="range" min={2} max={300} value={view === "arrange" ? ppsE : pps} onChange={(e) => (view === "arrange" ? setPpsE(+e.target.value) : setPps(+e.target.value))} />
        <button onClick={fitAll}>전체 보기</button>
        {view === "arrange" ? (
          <span className="clip-tools">
            <button className={magnet ? "on magnet" : "magnet"} onClick={() => setMagnet((v) => !v)} title="켜면 조각·레이어 항목이 0초·재생 위치·마커·다른 항목 가장자리에 가까울 때 달라붙습니다 (N)">
              🧲 자석 {magnet ? "켬" : "끔"}
            </button>
            <button onClick={() => actions.addMarker(arrange.time)} title="재생 위치에 마커를 찍습니다 (M)">◆ 마커</button>
            <button onClick={() => actions.addTrackOf("video")} title="영상 레이어를 맨 위에 추가합니다">＋영상 레이어</button>
            <button onClick={() => actions.addTrackOf("subtitle")} title="자막 레이어를 맨 위에 추가합니다">＋자막 레이어</button>
            <button onClick={() => actions.addTrackOf("audio")} title="음성 레이어를 맨 아래에 추가합니다">＋음성 레이어</button>
            <button onClick={resetLayout} disabled={layoutIsDefault}>배치 초기화</button>
            {multiSubs.length > 1 && <button onClick={() => mergeSubs(multiSubs)}>선택한 자막 {multiSubs.length}개 합치기</button>}
          </span>
        ) : selectedClips.length > 0 ? (
          <span className="clip-tools">
            클립 {selectedClips.length}개 선택
            <button onClick={makeGroup} disabled={selectedClips.length < 2} title="Ctrl+클릭으로 2개 이상 고르세요">🔗 그룹으로 묶기</button>
            <button onClick={ungroup} disabled={!groups.some((g) => g.clips.some((c) => selectedClips.includes(c)))}>그룹 풀기</button>
            <button onClick={() => setSelectedClips([])}>선택 해제</button>
          </span>
        ) : (
          <span>클립: 끌어서 순서 변경 · Ctrl+클릭으로 여러 개 선택 후 그룹</span>
        )}
        {view === "source" ? (
          <span className="legend">
            <i className="lg-cut" /> 잘릴 구간 <i className="lg-off" /> 제안(꺼짐, 더블클릭으로 적용) <i className="lg-review" /> 확인 필요
          </span>
        ) : (
          <span className="legend">끌어서 이동 · 위 레이어가 우선 표시 · S 나누기 · N 자석 · M 마커 · ↑↓ 편집점 이동</span>
        )}
      </div>
      {view === "arrange" ? (
        <ArrangeTimeline
          items={doc.layout}
          placed={placed}
          total={total}
          speeds={doc.speeds}
          tracks={doc.tracks}
          overlays={doc.overlays}
          assets={assets}
          clips={project.clips}
          markers={doc.markers}
          subs={subInst}
          wave={wave}
          time={arrange.time}
          playing={arrange.playing}
          pps={ppsE}
          setPps={setPpsE}
          magnet={magnet}
          selection={selection && ["piece", "sub", "overlay", "track", "marker"].includes(selection.kind) ? { kind: selection.kind as "piece", id: selection.id } : null}
          multiSubs={multiSubs}
          onSelect={onArrangeSelect}
          onSeek={arrange.seek}
          onLayout={setLayout}
          onOverlays={(next, record) => hist.set((d) => ({ ...d, overlays: next }), record)}
          onMoveFreeSub={moveFreeSub}
          onSubTrack={actions.setSubTrack}
          onSubMenu={(id, x, y) => setMenu({ id, x, y })}
          onPieceMenu={(id, x, y) => setPmenu({ kind: "piece", id, x, y })}
          onOverlayMenu={(id, x, y) => setPmenu({ kind: "overlay", id, x, y })}
          onTrackPatch={actions.patchTrack}
          onDropAsset={actions.dropAsset}
          begin={hist.begin}
          end={hist.end}
        />
      ) : (
      <Timeline
        duration={project.duration}
        clips={project.clips}
        doc={doc}
        pieces={pieces}
        wave={wave}
        time={time}
        playing={playing}
        pps={pps}
        setPps={setPps}
        selection={selection}
        onSelect={setSelection}
        onSeek={seek}
        update={updateTimeline}
        begin={hist.begin}
        end={hist.end}
        groups={groups}
        selectedClips={selectedClips}
        onSelectClips={setSelectedClips}
        onReorder={(order) => applyOrder(order, groups)}
        onRenameGroup={renameGroup}
      />
      )}
      {pmenu && (() => {
        const close = () => setPmenu(null);
        const pc = pmenu.kind === "piece" ? placed.find((x) => x.id === pmenu.id) : null;
        return (
          <>
            <div className="ctx-bg" onPointerDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            <div className="ctx-menu" style={{ left: pmenu.x, top: pmenu.y }}>
              {pc ? (
                <>
                  <div className="ctx-title">조각 · {(pc.e1 - pc.e0).toFixed(1)}초</div>
                  <button onClick={() => { actions.liftPiece(pmenu.id, true); close(); }}>위 영상 레이어로 올리기 (메인에서 빼기)</button>
                  <button onClick={() => { actions.liftPiece(pmenu.id, false); close(); }}>위 영상 레이어에 복사 (소리 없이)</button>
                  <button onClick={() => { const q = pieces.find((x) => x.id === pmenu.id); if (q) deletePiece(q); close(); }}>이 조각 지우기</button>
                  <div className="ctx-hint">올린 조각은 크기·위치·투명도를 바꿔 화면 속 화면(PIP)으로 쓸 수 있습니다</div>
                </>
              ) : (
                <>
                  <div className="ctx-title">레이어 항목</div>
                  <button onClick={() => { actions.splitSelected(pmenu.id, arrange.time); close(); }}>재생 위치에서 나누기</button>
                  <button onClick={() => { actions.deleteOverlay(pmenu.id); close(); }}>삭제</button>
                </>
              )}
            </div>
          </>
        );
      })()}
      {menu && (() => {
        const s = doc.subtitles.find((x) => x.id === menu.id);
        if (!s) return null;
        const multi = multiSubs.length > 1 && multiSubs.includes(menu.id);
        const close = () => setMenu(null);
        return (
          <>
            <div className="ctx-bg" onPointerDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
              <div className="ctx-title">{s.text.slice(0, 24)}</div>
              {multi && <button onClick={() => { mergeSubs(multiSubs); close(); }}>선택한 자막 {multiSubs.length}개 합치기</button>}
              {s.free ? (
                <button onClick={() => { attachSub(menu.id); close(); }}>조각에 다시 붙이기 (그룹에 넣기)</button>
              ) : (
                <button onClick={() => { detachSub(menu.id); close(); }}>그룹 해제 (조각에서 분리)</button>
              )}
              <button onClick={() => { hist.set((d) => ({ ...d, subtitles: d.subtitles.filter((x) => x.id !== menu.id) })); setSelection(null); close(); }}>자막 삭제</button>
              {!multi && <div className="ctx-hint">Ctrl+클릭으로 자막을 여러 개 고르면 '합치기'가 나옵니다</div>}
            </div>
          </>
        );
      })()}
    </div>
  );
}
