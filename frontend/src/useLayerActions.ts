import { useCallback } from "react";
import type { Asset, Clip, Subtitle } from "./api";
import type { EditDoc } from "./Inspector";
import type { Placed } from "./layout";
import {
  addTrack, fitOnTrack, firstFreeStart, grid, ofKind, removeTrack, splitOverlay, type Marker, type Overlay, type Track, type TrackKind,
} from "./layers";
import { newCut } from "./Timeline";
import { uid } from "./time";

interface Ctx {
  doc: EditDoc;
  set: (fn: (d: EditDoc) => EditDoc, record?: boolean) => void;
  placed: Placed[];
  assets: Asset[];
  clips: Clip[];
  playheadE: () => number; // 지금 재생 위치(결과 시간)
  select: (s: { kind: "overlay" | "track" | "marker" | "piece" | "sub"; id: string } | null) => void;
  notify: (msg: string) => void;
}

/** 추가 레이어(영상·이미지·음악·원본 조각)·트랙·마커 편집 동작 */
export function useLayerActions(c: Ctx) {
  const { doc, set, placed, assets, clips, select, notify } = c;

  const patchOverlay = useCallback(
    (id: string, patch: Partial<Overlay>, record = true) =>
      set((d) => ({ ...d, overlays: d.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)) }), record),
    [set],
  );

  const patchTrack = useCallback(
    (id: string, patch: Partial<Track>) => set((d) => ({ ...d, tracks: d.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
    [set],
  );

  const deleteOverlay = useCallback(
    (id: string) => {
      set((d) => ({ ...d, overlays: d.overlays.filter((o) => o.id !== id) }));
      select(null);
    },
    [set, select],
  );

  /** 같은 종류의 추가 트랙 중 start부터 dur만큼 비어 있는 첫 트랙(위 트랙부터 보지 않고 아래 트랙부터 채운다). 없으면 null */
  const pickTrack = (tracks: Track[], overlays: Overlay[], kind: "video" | "audio", start: number, dur: number): string | null => {
    const extras = ofKind(tracks, kind).filter((t) => !t.main && !t.locked);
    const ordered = kind === "video" ? [...extras].reverse() : extras; // 영상은 V2부터, 음성은 A2부터
    for (const t of ordered) {
      const others = overlays.filter((o) => o.track === t.id);
      if (fitOnTrack(others, start, dur) === grid(start)) return t.id;
    }
    return null;
  };

  /** 자료를 타임라인에 올린다. trackId·start를 주면(끌어다 놓기) 그 자리, 아니면 재생 위치의 첫 빈 트랙 */
  const addAsset = useCallback(
    (asset: Asset, trackId?: string, startE?: number) => {
      const isAudio = asset.kind === "audio";
      const kind: "video" | "audio" = isAudio ? "audio" : "video";
      const dur = asset.kind === "image" ? 5 : asset.duration;
      const id = uid("ov");
      set((d) => {
        let tracks = d.tracks;
        const want = Math.max(0, grid(startE ?? c.playheadE()));
        let tid = trackId && tracks.find((t) => t.id === trackId && t.kind === kind && !t.main && !t.locked) ? trackId : null;
        if (!tid) tid = pickTrack(tracks, d.overlays, kind, want, dur);
        if (!tid) {
          tracks = addTrack(tracks, kind);
          tid = ofKind(tracks, kind).find((t) => !d.tracks.some((x) => x.id === t.id))!.id;
        }
        const others = d.overlays.filter((o) => o.track === tid);
        const start = trackId ? fitOnTrack(others, want, dur) : firstFreeStart(others, want, dur);
        const o: Overlay = {
          id, track: tid, type: asset.kind, src: asset.id, src_in: 0, src_out: dur, dur, start, volume: 1, fade_in: 0, fade_out: 0,
          has_audio: asset.has_audio,
          ...(isAudio ? {} : { x: 0.5, y: 0.5, scale: 1, opacity: 1 }),
        };
        return { ...d, tracks, overlays: [...d.overlays, o] };
      });
      select({ kind: "overlay", id });
    },
    [set, select, c.playheadE],
  );

  const dropAsset = useCallback(
    (assetId: string, trackId: string, e: number) => {
      const a = assets.find((x) => x.id === assetId);
      if (!a) return;
      const t = doc.tracks.find((x) => x.id === trackId);
      if (!t || (a.kind === "audio") !== (t.kind === "audio") || t.kind === "subtitle") {
        notify(a.kind === "audio" ? "음악·효과음은 음성 레이어(A2~)에 놓을 수 있습니다." : "영상·이미지는 영상 레이어(V2~)에 놓을 수 있습니다.");
        return;
      }
      addAsset(a, trackId, e);
    },
    [assets, doc.tracks, addAsset, notify],
  );

  /** 재생 위치에서 선택한 항목을 둘로 나눈다 */
  const splitSelected = useCallback(
    (id: string, e: number): boolean => {
      const o = doc.overlays.find((x) => x.id === id);
      if (!o) return false;
      const nid = uid("ov");
      const r = splitOverlay(o, e, nid);
      if (!r) {
        notify("재생 위치가 항목 안쪽(양 끝에서 0.1초 이상)이어야 나눌 수 있습니다.");
        return true;
      }
      set((d) => ({ ...d, overlays: d.overlays.flatMap((x) => (x.id === id ? r : [x])) }));
      return true;
    },
    [doc.overlays, set, notify],
  );

  /** 메인 영상의 조각을 위 영상 레이어로 올린다. move=true면 메인에서는 뺀다(자리는 빈칸으로 남는다). 복사는 소리 없이 올린다. */
  const liftPiece = useCallback(
    (pieceId: string, move: boolean) => {
      const it = placed.find((p) => p.id === pieceId);
      if (!it) return;
      const clip = clips.find((cl) => it.a >= cl.offset - 1e-4 && it.a < cl.offset + cl.duration - 1e-4);
      if (!clip) return;
      const dur = it.b - it.a;
      const id = uid("ov");
      set((d) => {
        let tracks = d.tracks;
        let tid = pickTrack(tracks, d.overlays, "video", it.e0, dur);
        if (!tid) {
          tracks = addTrack(tracks, "video");
          tid = ofKind(tracks, "video").find((t) => !d.tracks.some((x) => x.id === t.id))!.id;
        }
        const local = it.a - clip.offset;
        const o: Overlay = {
          id, track: tid, type: "clip", src: clip.id, src_in: local, src_out: local + dur, dur, start: it.e0,
          volume: move ? 1 : 0, fade_in: 0, fade_out: 0, x: 0.5, y: 0.5, scale: 1, opacity: 1, has_audio: clip.has_audio, carry_subs: move,
        };
        let next: EditDoc = { ...d, tracks, overlays: [...d.overlays, o] };
        if (move) {
          // 메인에서 빼되, 뒤 조각이 당겨지지 않게 그 길이를 다음 조각 앞 빈칸으로 넘긴다
          const idx = d.layout.findIndex((x) => x.id === pieceId);
          const cutId = uid("cut");
          const length = it.e1 - it.e0;
          const layout = d.layout
            .filter((x) => x.id !== pieceId)
            .map((x, i) => (i === idx ? { ...x, gap: x.gap + d.layout[idx].gap + length } : x));
          next = { ...next, layout, cuts: [...d.cuts, newCut(cutId, it.a, it.b)] };
        }
        return next;
      });
      select({ kind: "overlay", id });
    },
    [placed, clips, set, select],
  );

  // ---------- 트랙 ----------
  const addTrackOf = useCallback((kind: TrackKind) => set((d) => ({ ...d, tracks: addTrack(d.tracks, kind) })), [set]);

  const removeTrackById = useCallback(
    (id: string) => {
      const used = doc.overlays.filter((o) => o.track === id).length + doc.subtitles.filter((s) => s.track === id).length;
      if (used > 0 && !confirm(`이 레이어에는 항목이 ${used}개 있습니다. 레이어와 함께 지울까요? (자막은 맨 아래 자막 레이어로 옮겨집니다)`)) return;
      set((d) => {
        const r = removeTrack(d.tracks, d.overlays, id);
        const fallback = ofKind(r.tracks, "subtitle").slice(-1)[0]?.id;
        const subtitles: Subtitle[] = d.subtitles.map((s) => (s.track === id ? { ...s, track: fallback } : s));
        return { ...d, tracks: r.tracks, overlays: r.overlays, subtitles };
      });
      select(null);
    },
    [doc.overlays, doc.subtitles, set, select],
  );

  const setSubTrack = useCallback(
    (id: string, track: string, record: boolean) =>
      set((d) => ({ ...d, subtitles: d.subtitles.map((s) => (s.id === id ? { ...s, track } : s)) }), record),
    [set],
  );

  // ---------- 마커 ----------
  const addMarker = useCallback(
    (t: number) => {
      const id = uid("mk");
      const m: Marker = { id, t: grid(t), name: "", color: "#ffb020" };
      set((d) => ({ ...d, markers: [...d.markers, m].sort((a, b) => a.t - b.t) }));
      select({ kind: "marker", id });
    },
    [set, select],
  );

  const patchMarker = useCallback(
    (id: string, patch: Partial<Marker>) =>
      set((d) => ({ ...d, markers: d.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)).sort((a, b) => a.t - b.t) })),
    [set],
  );

  const deleteMarker = useCallback(
    (id: string) => {
      set((d) => ({ ...d, markers: d.markers.filter((m) => m.id !== id) }));
      select(null);
    },
    [set, select],
  );

  return {
    patchOverlay, patchTrack, deleteOverlay, addAsset, dropAsset, splitSelected, liftPiece, addTrackOf, removeTrackById,
    setSubTrack, addMarker, patchMarker, deleteMarker,
  };
}
