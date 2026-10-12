// 타임라인 '조각' 계산: 컷으로 잘리지 않고 남는 구간을 나눈 지점·클립 경계에서 쪼갠 것.
// 화면 코드와 분리한 순수 함수라 frontend/tests/pieces.test.mjs 로 검증한다.

export const FPS = 30;
const EPS = 1e-4;
const snap = (t: number) => Math.round(t * FPS) / FPS;

export interface CutLike {
  id: string;
  start: number;
  end: number;
  enabled: boolean;
  origin?: string;
}

export interface Piece {
  id: string;
  start: number;
  end: number;
}

/** 조각 가장자리가 무엇에 맞닿아 있는지: cut=잘린 구간, split=나눈 지점, fixed=영상 처음/끝·클립 경계 */
export type EdgeKind = "cut" | "split" | "fixed";

/** 켜진 컷을 합친 목록 */
export function mergedRanges(cuts: CutLike[]): [number, number][] {
  const on = cuts.filter((c) => c.enabled).map((c) => [c.start, c.end] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of on) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + EPS) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function computePieces(duration: number, cuts: CutLike[], splits: number[], clipEdges: number[]): Piece[] {
  const kept: [number, number][] = [];
  let cur = 0;
  for (const [s, e] of mergedRanges(cuts)) {
    if (s > cur + EPS) kept.push([cur, Math.min(s, duration)]);
    cur = Math.max(cur, e);
  }
  if (cur < duration - EPS) kept.push([cur, duration]);

  const marks = [...new Set([...splits, ...clipEdges].map((t) => snap(t)))].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (const [s, e] of kept) {
    let a = s;
    for (const m of marks) {
      if (m > a + EPS && m < e - EPS) {
        pieces.push({ id: "", start: a, end: m });
        a = m;
      }
    }
    pieces.push({ id: "", start: a, end: e });
  }
  return pieces
    .filter((p) => p.end - p.start >= 1 / FPS - EPS)
    .map((p) => ({ ...p, id: `pc-${Math.round(p.start * FPS)}` }));
}

export function edgeKind(side: "l" | "r", piece: Piece, cuts: CutLike[], splits: number[]): EdgeKind {
  const t = side === "l" ? piece.start : piece.end;
  for (const [s, e] of mergedRanges(cuts)) {
    if (side === "l" && Math.abs(e - t) < EPS) return "cut";
    if (side === "r" && Math.abs(s - t) < EPS) return "cut";
  }
  return splits.some((m) => Math.abs(m - t) < EPS) ? "split" : "fixed";
}

/** 이 가장자리에 맞닿은, 합쳐진 컷 구간 [시작, 끝]. 없으면 null */
export function adjacentCut(side: "l" | "r", piece: Piece, cuts: CutLike[]): [number, number] | null {
  const t = side === "l" ? piece.start : piece.end;
  return mergedRanges(cuts).find(([s, e]) => Math.abs((side === "l" ? e : s) - t) < EPS) ?? null;
}

/** [a, b] 안의 켜진 컷을 걷어낸다(원본을 되살린다). 걸친 컷은 바깥쪽 남는 부분만 둔다. 고친 컷은 '직접 수정'으로 바뀐다. */
export function reviveRange<T extends CutLike>(cuts: T[], a: number, b: number, newId: () => string): T[] {
  const out: T[] = [];
  for (const c of cuts) {
    if (!c.enabled || c.end <= a + EPS || c.start >= b - EPS) {
      out.push(c);
      continue;
    }
    const leftPart = c.start < a - EPS;
    const rightPart = c.end > b + EPS;
    if (leftPart) out.push({ ...c, end: a, origin: "user" });
    if (rightPart) out.push({ ...c, id: leftPart ? newId() : c.id, start: b, origin: "user" });
  }
  return out;
}

/** 나눈 지점을 옮길 때 허용되는 범위(양옆 조각이 1프레임보다 짧아지지 않게) */
export function splitBounds(piece: Piece, side: "l" | "r", pieces: Piece[]): [number, number] {
  const i = pieces.findIndex((p) => p.id === piece.id);
  if (side === "l") {
    const left = pieces[i - 1];
    return [(left ? left.start : 0) + 1 / FPS, piece.end - 1 / FPS];
  }
  const right = pieces[i + 1];
  return [piece.start + 1 / FPS, (right ? right.end : piece.end) - 1 / FPS];
}
