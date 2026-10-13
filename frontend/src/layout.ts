// 결과 배치(layout): 조각마다 결과 영상에서의 위치를 따로 갖는다.
// - 조각(Item)은 원본 타임라인(P)의 구간 [a, b]. 순서(E 순서)와 '앞 빈칸'(gap)만 저장하고 절대 위치는 계산한다.
//   그래서 길이(배속·연장)가 바뀌어도 겹침이 생기지 않고, 빈칸은 그대로 유지된다.
// - 모든 길이는 30fps 프레임 정수로 센다. 파이썬(backend/core/layout.py)이 같은 식으로 계산해 화면과 결과 영상이 어긋나지 않는다.
// 화면 코드와 분리한 순수 함수라 frontend/tests/layout.test.mjs 로 검증한다.

export const FPS = 30;
const EPS = 1e-6;
export const grid = (t: number) => Math.round(t * FPS) / FPS;
const fr = (t: number) => Math.round(t * FPS);

export interface Range {
  a: number;
  b: number;
}

export interface Item extends Range {
  id: string;
  gap: number; // 이 조각 앞의 빈칸(초). 첫 조각이면 영상 시작 전 빈칸
}

export interface SpeedLike {
  start: number;
  end: number;
  speed: number;
}

export interface Atom extends Range {
  speed: number;
  e0: number; // 결과 영상 시간(초)
  e1: number;
}

export interface Placed extends Item {
  e0: number;
  e1: number;
  atoms: Atom[];
}

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 4;

/** 배속 구간 정리: 범위 제한, 격자 맞춤, 겹침 제거, 1배속·너무 짧은 구간 제거 (서버 export.merged_speeds와 같은 규칙) */
export function cleanSpeeds(speeds: SpeedLike[]): SpeedLike[] {
  const out: SpeedLike[] = [];
  for (const r of [...speeds].sort((x, y) => x.start - y.start)) {
    const sp = Math.min(Math.max(r.speed, MIN_SPEED), MAX_SPEED);
    let s = grid(r.start);
    const e = grid(r.end);
    if (out.length) s = Math.max(s, out[out.length - 1].end);
    if (e - s < 1 / FPS - EPS || Math.abs(sp - 1) < EPS) continue;
    out.push({ start: s, end: e, speed: sp });
  }
  return out;
}

/** 조각을 배속 경계에서 나눈 조각들. 길이는 프레임 정수: 원본 N프레임 → 결과 round(N / 배속)프레임 */
export function atomsOf(item: Range, speeds: SpeedLike[], startFrame: number): Atom[] {
  const atoms: Atom[] = [];
  let f = startFrame;
  let cur = grid(item.a);
  const end = grid(item.b);
  const push = (a: number, b: number, speed: number) => {
    const srcF = fr(b - a);
    if (srcF <= 0) return;
    const outF = Math.max(1, Math.round(srcF / speed));
    atoms.push({ a, b, speed, e0: f / FPS, e1: (f + outF) / FPS });
    f += outF;
  };
  for (const r of speeds) {
    if (r.end <= cur + EPS || r.start >= end - EPS) continue;
    if (r.start > cur + EPS) push(cur, r.start, 1);
    const lo = Math.max(cur, r.start);
    const hi = Math.min(end, r.end);
    push(lo, hi, r.speed);
    cur = hi;
  }
  if (end - cur > EPS) push(cur, end, 1);
  return atoms;
}

export function placeItems(items: Item[], speedsIn: SpeedLike[]): { placed: Placed[]; total: number } {
  const speeds = cleanSpeeds(speedsIn);
  const placed: Placed[] = [];
  let cursor = 0; // 프레임
  for (const it of items) {
    const start = cursor + Math.max(0, fr(it.gap));
    const atoms = atomsOf(it, speeds, start);
    const endF = atoms.length ? fr(atoms[atoms.length - 1].e1) : start;
    placed.push({ ...it, e0: start / FPS, e1: endF / FPS, atoms });
    cursor = endF;
  }
  return { placed, total: cursor / FPS };
}

/** 원본 시간 p → 결과 시간. p가 속한 조각이 없으면 null */
export function pToE(placed: Placed[], p: number): number | null {
  for (const it of placed) {
    if (p < it.a - EPS || p > it.b + EPS) continue;
    for (const at of it.atoms) {
      if (p >= at.a - EPS && p <= at.b + EPS) {
        const r = (at.e1 - at.e0) / (at.b - at.a);
        return at.e0 + (p - at.a) * r;
      }
    }
  }
  return null;
}

/** 결과 시간 e → 그 순간의 조각과 원본 시간. 빈칸이거나 끝을 넘으면 null */
export function eToP(placed: Placed[], e: number): { item: Placed; atom: Atom; p: number } | null {
  for (const it of placed) {
    if (e < it.e0 - EPS || e >= it.e1 - EPS) continue;
    for (const at of it.atoms) {
      if (e >= at.e0 - EPS && e < at.e1 - EPS) {
        const r = (at.e1 - at.e0) / (at.b - at.a);
        return { item: it, atom: at, p: at.a + (e - at.e0) / r };
      }
    }
  }
  return null;
}

/** e 이후에 처음 시작하는 조각(빈칸 건너뛰기용) */
export function nextItemAfter(placed: Placed[], e: number): Placed | null {
  return placed.find((it) => it.e0 > e + EPS) ?? null;
}

// ---------------- 원본 컷·나눔이 바뀔 때 배치를 맞추기 ----------------

/**
 * pieces(컷·나눈 지점으로 정해진 '남는 구간')에 맞춰 배치를 다시 만든다.
 * - 겹침이 가장 큰 기존 조각이 id·빈칸·위치를 이어받는다(끌어서 늘리거나 줄여도 조각이 유지됨).
 * - 한 조각이 둘로 나뉘면 나뉜 조각들이 원래 자리에 이어 놓인다(나누기만으로는 결과가 안 바뀜).
 * - 지워진 조각의 빈칸은 다음 조각으로 넘긴다(앞이 닫히지만 의도한 빈칸은 유지).
 * - 새로 살아난 구간은 원본에서 바로 앞 조각 뒤에 놓인다.
 */
export function reconcile(old: Item[], pieces: Range[]): Item[] {
  const ps = [...pieces].sort((x, y) => x.a - y.a);
  const overlap = (x: Range, p: Range) => Math.min(x.b, p.b) - Math.max(x.a, p.a);

  const owner = ps.map((p) => {
    let best = -1;
    let bo = 1e-4;
    old.forEach((x, i) => {
      const o = overlap(x, p);
      if (o > bo + 1e-9) {
        bo = o;
        best = i;
      }
    });
    return best;
  });

  const used = new Set<string>();
  const keepsId = new Map<number, number>(); // 기존 조각 index → id를 이어받는 piece index
  old.forEach((x, i) => {
    let best = -1;
    let bo = -1;
    ps.forEach((p, k) => {
      if (owner[k] !== i) return;
      const o = overlap(x, p);
      if (o > bo + 1e-9) {
        bo = o;
        best = k;
      }
    });
    if (best >= 0) {
      keepsId.set(i, best);
      used.add(x.id);
    }
  });
  const newId = (p: Range) => {
    const base = `pc-${fr(p.a)}`;
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return id;
  };

  const res: Item[] = [];
  let carry = 0;
  old.forEach((x, i) => {
    const group = ps.map((p, k) => ({ p, k })).filter((g) => owner[g.k] === i);
    if (!group.length) {
      carry += Math.max(0, x.gap);
      return;
    }
    group.forEach((g, j) => {
      const inherits = keepsId.get(i) === g.k;
      res.push({
        id: inherits ? x.id : newId(g.p),
        a: g.p.a,
        b: g.p.b,
        gap: j === 0 ? Math.max(0, x.gap) + carry : 0,
      });
      if (j === 0) carry = 0;
    });
  });
  // 남은 carry(맨 뒤 조각들이 지워진 경우)는 버린다.

  ps.forEach((p, k) => {
    if (owner[k] !== -1) return;
    let at = -1;
    res.forEach((r, idx) => {
      if (r.b <= p.a + EPS && (at === -1 || r.b >= res[at].b - EPS)) at = idx;
    });
    res.splice(at + 1, 0, { id: newId(p), a: p.a, b: p.b, gap: 0 });
  });
  return res;
}

/** 원본 순서 그대로, 빈칸 없이 이어진 배치인가(= 기존 방식의 결과와 같다) */
export function isDefaultLayout(items: Item[]): boolean {
  for (let i = 0; i < items.length; i++) {
    if (items[i].gap > EPS) return false;
    if (i > 0 && items[i].a < items[i - 1].a + EPS) return false;
  }
  return true;
}

// ---------------- 끌어서 옮기기 + 자석 ----------------

export interface MoveOpts {
  magnet: boolean;
  threshold: number; // 자석이 붙는 거리(초)
  playhead?: number | null; // 재생 위치(결과 시간)도 붙는 대상
  pointer?: number | null; // 끌고 있는 마우스의 결과 시간 위치(순서 판단용)
}

/**
 * 조각 id를 결과 시간 startE에 놓는다.
 * - 다른 조각은 원래 절대 위치를 지킨다(빠진 자리는 빈칸이 된다). 겹치면 뒤 조각들이 밀려난다.
 * - 순서는 놓은 조각의 중심 위치로 정해진다(다른 조각 앞뒤로 넘기면 순서가 바뀐다).
 * - 자석이 켜져 있으면 가장자리가 0초·재생 위치·다른 조각 가장자리에 가까울 때 정확히 붙는다.
 */
export function moveItem(
  items: Item[],
  speeds: SpeedLike[],
  id: string,
  startE: number,
  opts: MoveOpts,
): { items: Item[]; snap: number | null } {
  const { placed } = placeItems(items, speeds);
  const m = placed.find((p) => p.id === id);
  if (!m) return { items, snap: null };
  const lenF = fr(m.e1) - fr(m.e0);
  const L = lenF / FPS;
  const others = placed.filter((p) => p.id !== id);

  let x = Math.max(0, grid(startE));
  let snap: number | null = null;
  if (opts.magnet) {
    const pts = [0, ...(opts.playhead != null ? [opts.playhead] : []), ...others.flatMap((o) => [o.e0, o.e1])];
    let best = opts.threshold;
    for (const pt of pts) {
      const dl = Math.abs(x - pt);
      const dr = Math.abs(x + L - pt);
      if (dl < best - EPS) {
        best = dl;
        x = pt;
        snap = pt;
      }
      if (dr < best - EPS) {
        best = dr;
        x = pt - L;
        snap = pt;
      }
    }
    // 오른쪽 가장자리를 붙이다 0보다 작아졌으면 0에 둔다
    if (x < 0) {
      x = 0;
      snap = 0;
    }
  }
  const xf = fr(x);

  // 순서는 마우스가 가리키는 위치(없으면 조각 중심)가 다른 조각의 중심을 넘었는지로 정한다.
  // 긴 조각은 0초에 막혀 중심이 짧은 조각 중심보다 앞으로 못 가므로 마우스 위치를 기준으로 삼는다.
  const key = opts.pointer ?? x + L / 2;
  const k = others.filter((o) => (o.e0 + o.e1) / 2 < key).length;
  const order = [...others.slice(0, k), m, ...others.slice(k)];

  const out: Item[] = [];
  let cursor = 0;
  for (const it of order) {
    const len = it === m ? lenF : fr(it.e1) - fr(it.e0);
    const desired = it === m ? xf : fr(it.e0);
    const start = Math.max(desired, cursor);
    out.push({ id: it.id, a: it.a, b: it.b, gap: (start - cursor) / FPS });
    cursor = start + len;
  }
  return { items: out, snap };
}

/** 조각 앞 빈칸을 바꾼다. 뒤 조각들은 따라서 밀린다. */
export function setGap(items: Item[], id: string, gap: number): Item[] {
  return items.map((it) => (it.id === id ? { ...it, gap: Math.max(0, grid(gap)) } : it));
}

// ---------------- 자막 ----------------

export interface SubLike {
  id: string;
  start: number;
  end: number;
  text: string;
  track?: string;
  free?: boolean; // 조각에서 분리된 자막: 결과 시간(e_start~e_end)에 고정
  e_start?: number;
  e_end?: number;
}

/** 자막이 따라가는 소재 구간: 원본 시간 [a, b] → 결과 시간 [e0, e1] (다른 레이어로 올린 조각도 이 모양) */
export interface ExtraAtom {
  a: number;
  b: number;
  e0: number;
  e1: number;
}

export interface SubInstance {
  id: string;
  track?: string;
  text: string;
  e0: number;
  e1: number;
  free: boolean;
}

/** 자막을 결과 시간으로 옮긴 목록. 조각을 따라가는 자막은 자기 원본 구간이 놓인 자리에 나타난다. */
export function subInstances(placed: Placed[], subs: SubLike[], extra: ExtraAtom[] = []): SubInstance[] {
  const atoms: ExtraAtom[] = [...placed.flatMap((it) => it.atoms), ...extra];
  const out: SubInstance[] = [];
  for (const s of subs) {
    if (s.free) {
      if (s.e_start != null && s.e_end != null && s.e_end > s.e_start)
        out.push({ id: s.id, track: s.track, text: s.text, e0: s.e_start, e1: s.e_end, free: true });
      continue;
    }
    const parts: [number, number][] = [];
    for (const at of atoms) {
      const lo = Math.max(s.start, at.a);
      const hi = Math.min(s.end, at.b);
      if (hi - lo <= EPS) continue;
      const r = (at.e1 - at.e0) / (at.b - at.a);
      parts.push([at.e0 + (lo - at.a) * r, at.e0 + (hi - at.a) * r]);
    }
    parts.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const p of parts) {
      const last = merged[merged.length - 1];
      if (last && p[0] <= last[1] + 1e-4) last[1] = Math.max(last[1], p[1]);
      else merged.push([p[0], p[1]]);
    }
    for (const [e0, e1] of merged) out.push({ id: s.id, track: s.track, text: s.text, e0, e1, free: false });
  }
  return out.sort((x, y) => x.e0 - y.e0);
}
