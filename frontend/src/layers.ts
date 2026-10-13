// 레이어(트랙) 순수 계산: 기본 트랙, 트랙 추가·삭제, 겹침 방지, 자석, 편집점, 미리보기용 시간·페이드.
// 서버(backend/core/layers.py)와 같은 규칙을 쓴다. 화면 코드와 분리해 frontend/tests/layers.test.mjs 로 검증한다.

export const FPS = 30;
const EPS = 1e-6;
export const grid = (t: number) => Math.round(t * FPS) / FPS;

export type TrackKind = "video" | "audio" | "subtitle";

export interface TrackStyle {
  position?: "top" | "bottom";
  margin?: number;
  size?: number;
  color?: string;
  outline_color?: string;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  main?: boolean;
  hidden?: boolean; // 영상·자막: 눈 아이콘
  muted?: boolean; // 음성: 스피커 아이콘
  locked: boolean;
  volume?: number; // 음성 트랙 볼륨(0~2)
  style?: TrackStyle | null; // 자막 트랙 스타일(전체 기본 스타일 위에 덮어씀)
}

export type OverlayType = "video" | "image" | "audio" | "clip";

export interface Overlay {
  id: string;
  track: string;
  type: OverlayType;
  src: string; // 자료 id 또는 클립 id
  src_in: number;
  src_out: number;
  dur: number;
  start: number; // 결과 영상 시간(초)
  volume: number;
  fade_in: number;
  fade_out: number;
  x?: number; // 화면 중심 위치(0~1)
  y?: number;
  scale?: number; // 화면에 맞춘 크기 대비 배율
  opacity?: number;
  has_audio?: boolean;
  carry_subs?: boolean; // 원본 영상 조각 레이어: 그 구간의 자막을 함께 가져간다
}

export interface Marker {
  id: string;
  t: number;
  name: string;
  color: string;
}

export const MIN_ITEM = 0.1;
export const MIN_TRACKS = 3;
const KIND_ORDER: Record<TrackKind, number> = { subtitle: 0, video: 1, audio: 2 };

export function defaultTracks(): Track[] {
  const t: Track[] = [];
  for (const n of [3, 2, 1]) t.push({ id: `S${n}`, kind: "subtitle", name: `자막 ${n}`, hidden: false, locked: false, style: null });
  for (const n of [3, 2, 1]) t.push({ id: `V${n}`, kind: "video", name: n === 1 ? "메인 영상" : `영상 ${n}`, hidden: false, locked: false, main: n === 1 });
  for (const n of [1, 2, 3]) t.push({ id: `A${n}`, kind: "audio", name: n === 1 ? "메인 음성" : `음성 ${n}`, muted: false, locked: false, volume: 1, main: n === 1 });
  return t;
}

export const ofKind = (tracks: Track[], kind: TrackKind) => tracks.filter((t) => t.kind === kind);

/** 새 트랙 id: 종류 접두어 + 아직 안 쓰인 가장 작은 번호 */
export function nextTrackId(tracks: Track[], kind: TrackKind): string {
  const p = kind === "video" ? "V" : kind === "audio" ? "A" : "S";
  const used = new Set(tracks.map((t) => t.id));
  let n = 1;
  while (used.has(`${p}${n}`)) n++;
  return `${p}${n}`;
}

/** 트랙 추가: 영상·자막은 그 종류의 맨 위(우선순위가 가장 높게), 음성은 맨 아래에 붙는다(프리미어와 같은 방식). */
export function addTrack(tracks: Track[], kind: TrackKind): Track[] {
  const id = nextTrackId(tracks, kind);
  const label = kind === "video" ? "영상" : kind === "audio" ? "음성" : "자막";
  const t: Track = kind === "audio"
    ? { id, kind, name: `${label} ${id.slice(1)}`, muted: false, locked: false, volume: 1 }
    : { id, kind, name: `${label} ${id.slice(1)}`, hidden: false, locked: false, style: kind === "subtitle" ? null : undefined };
  const out = [...tracks];
  const idx = out.map((x) => x.kind).lastIndexOf(kind);
  if (kind === "audio") out.splice(idx + 1, 0, t);
  else out.splice(out.findIndex((x) => x.kind === kind), 0, t);
  return out;
}

/** 트랙 삭제 가능 여부: 메인은 안 되고, 종류마다 3개는 남겨 둔다 */
export function canRemoveTrack(tracks: Track[], id: string): boolean {
  const t = tracks.find((x) => x.id === id);
  return !!t && !t.main && ofKind(tracks, t.kind).length > MIN_TRACKS;
}

export function removeTrack(tracks: Track[], overlays: Overlay[], id: string): { tracks: Track[]; overlays: Overlay[] } {
  if (!canRemoveTrack(tracks, id)) return { tracks, overlays };
  return { tracks: tracks.filter((t) => t.id !== id), overlays: overlays.filter((o) => o.track !== id) };
}

export const sortTracks = (tracks: Track[]) =>
  [...tracks].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.kind === "video" ? Number(!!a.main) - Number(!!b.main) : 0));

// ---------------- 항목 위치 ----------------

export const itemEnd = (o: { start: number; dur: number }) => o.start + o.dur;

/**
 * 같은 트랙의 다른 항목과 겹치지 않는 가장 가까운 시작 위치(0 이상).
 * 원하는 자리가 비어 있으면 그대로, 막혀 있으면 막은 항목의 앞이나 뒤 중 더 가까운 쪽.
 */
export function fitOnTrack(others: { start: number; dur: number }[], start: number, dur: number): number {
  const s0 = Math.max(0, grid(start));
  const free = (s: number) => s >= -EPS && others.every((o) => s + dur <= o.start + EPS || s >= itemEnd(o) - EPS);
  if (free(s0)) return s0;
  const cands = [0, ...others.flatMap((o) => [itemEnd(o), o.start - dur])].filter((c) => c >= -EPS && free(c));
  if (!cands.length) return s0;
  return cands.reduce((best, c) => (Math.abs(c - s0) < Math.abs(best - s0) ? c : best));
}

/** 처음 자리부터 오른쪽으로 훑어 dur 길이가 들어가는 첫 빈자리 */
export function firstFreeStart(others: { start: number; dur: number }[], from: number, dur: number): number {
  let s = Math.max(0, grid(from));
  for (const o of [...others].sort((a, b) => a.start - b.start)) {
    if (s + dur <= o.start + EPS) break;
    if (s < itemEnd(o) - EPS) s = itemEnd(o);
  }
  return s;
}

export interface SnapResult {
  start: number;
  snap: number | null;
}

/** 시작·끝 가장자리가 가까운 기준점에 붙는다. points: 0, 재생 위치, 마커, 다른 항목 가장자리 등 */
export function snapStart(start: number, dur: number, points: number[], threshold: number): SnapResult {
  let best = threshold;
  let s = start;
  let hit: number | null = null;
  for (const p of points) {
    const dl = Math.abs(start - p);
    const dr = Math.abs(start + dur - p);
    if (dl < best - EPS) {
      best = dl;
      s = p;
      hit = p;
    }
    if (dr < best - EPS) {
      best = dr;
      s = p - dur;
      hit = p;
    }
  }
  return { start: Math.max(0, s), snap: hit };
}

/** 한 점(트림하는 가장자리)만 붙는다 */
export function snapPoint(t: number, points: number[], threshold: number): { t: number; snap: number | null } {
  let best = threshold;
  let out = t;
  let hit: number | null = null;
  for (const p of points) {
    const d = Math.abs(t - p);
    if (d < best - EPS) {
      best = d;
      out = p;
      hit = p;
    }
  }
  return { t: out, snap: hit };
}

// ---------------- 길이·편집점 ----------------

/** 보이는(숨기지 않은) 영상 트랙과 소리 나는(음소거 아닌) 음성 트랙의 항목만 결과 길이에 들어간다(서버 build_plan과 같다) */
export function activeOverlays(tracks: Track[], overlays: Overlay[]): Overlay[] {
  const tm = new Map(tracks.map((t) => [t.id, t]));
  return overlays.filter((o) => {
    const t = tm.get(o.track);
    if (!t) return false;
    return t.kind === "audio" ? !t.muted : !t.hidden;
  });
}

export function totalWithLayers(mainTotal: number, tracks: Track[], overlays: Overlay[]): number {
  return Math.max(mainTotal, ...activeOverlays(tracks, overlays).map(itemEnd));
}

/** ↑/↓ 이동용 편집점: 0, 조각·항목 시작/끝, 마커 */
export function editPoints(pieceEdges: number[], overlays: Overlay[], markers: Marker[]): number[] {
  const set = new Set<number>([0]);
  for (const t of [...pieceEdges, ...overlays.flatMap((o) => [o.start, itemEnd(o)]), ...markers.map((m) => m.t)]) set.add(Math.round(t * 1000) / 1000);
  return [...set].sort((a, b) => a - b);
}

export function prevPoint(points: number[], t: number): number | null {
  const c = points.filter((p) => p < t - 0.02);
  return c.length ? c[c.length - 1] : null;
}

export function nextPoint(points: number[], t: number): number | null {
  return points.find((p) => p > t + 0.02) ?? null;
}

// ---------------- 미리보기 ----------------

/** 항목 안의 시각 e에서 페이드를 반영한 배율(0~1) */
export function fadeFactor(o: Pick<Overlay, "start" | "dur" | "fade_in" | "fade_out">, e: number): number {
  let f = 1;
  if (o.fade_in > 0) f = Math.min(f, Math.max(0, (e - o.start) / o.fade_in));
  if (o.fade_out > 0) f = Math.min(f, Math.max(0, (o.start + o.dur - e) / o.fade_out));
  return Math.max(0, Math.min(1, f));
}

export const isActive = (o: Pick<Overlay, "start" | "dur">, e: number) => e >= o.start - 1e-6 && e < o.start + o.dur - 1e-6;

/** 화면에 맞춘 크기(contain)를 영역 안에 계산 */
export function fitSize(aspect: number, w: number, h: number): { w: number; h: number } {
  if (!isFinite(aspect) || aspect <= 0) return { w, h };
  return aspect > w / h ? { w, h: w / aspect } : { w: h * aspect, h };
}

// ---------------- 편집 동작 ----------------

/** 항목을 재생 위치 t에서 둘로 나눈다. 안에 들어 있지 않으면 null */
export function splitOverlay(o: Overlay, t: number, newId: string): [Overlay, Overlay] | null {
  const cut = grid(t);
  if (cut - o.start < MIN_ITEM - EPS || itemEnd(o) - cut < MIN_ITEM - EPS) return null;
  const firstDur = cut - o.start;
  const a: Overlay = { ...o, dur: firstDur, src_out: o.type === "image" ? o.src_out : o.src_in + firstDur, fade_out: 0 };
  const b: Overlay = {
    ...o, id: newId, start: cut, dur: o.dur - firstDur, fade_in: 0,
    src_in: o.type === "image" ? o.src_in : o.src_in + firstDur,
  };
  if (o.type === "image") {
    a.src_out = firstDur;
    b.src_out = b.dur;
  }
  return [a, b];
}

/** 가장자리를 끌어 길이를 바꾼다(트림). 원본 길이(srcLen)를 넘지 못하고, 이미지는 길이만 바뀐다. */
export function trimOverlay(o: Overlay, side: "l" | "r", t: number, srcLen: number): Overlay {
  const end = itemEnd(o);
  if (side === "r") {
    let dur = Math.max(MIN_ITEM, grid(t) - o.start);
    if (o.type !== "image") dur = Math.min(dur, srcLen - o.src_in);
    return { ...o, dur, src_out: o.type === "image" ? dur : o.src_in + dur, fade_out: Math.min(o.fade_out, dur) };
  }
  let start = Math.min(grid(t), end - MIN_ITEM);
  start = Math.max(0, start);
  if (o.type !== "image") start = Math.max(start, o.start - o.src_in); // 원본 처음보다 앞으로는 못 간다
  const dur = end - start;
  const src_in = o.type === "image" ? 0 : o.src_in + (start - o.start);
  return { ...o, start, dur, src_in, src_out: o.type === "image" ? dur : src_in + dur, fade_in: Math.min(o.fade_in, dur) };
}
