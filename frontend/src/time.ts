export const FPS = 30;

/** 초 → "m:ss.s" (1시간 이상이면 "h:mm:ss.s") */
export function fmt(t: number, digits = 1): string {
  if (!isFinite(t)) return "-";
  const sign = t < 0 ? "-" : "";
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(digits).padStart(digits ? 3 + digits : 2, "0");
  return h ? `${sign}${h}:${String(m).padStart(2, "0")}:${s}` : `${sign}${m}:${s}`;
}

/** 프레임 단위(1/30초)로 맞춘다. 내보내기와 같은 격자를 쓰기 위해서다. */
export const snap = (t: number) => Math.round(t * FPS) / FPS;

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 타임라인 시간 t까지 남는 결과 영상 시간. 컷은 빼고, 배속 구간은 (길이 ÷ 배속)만 센다. 서버(export.map_time)와 같은 식이다. */
export function outputTime(t: number, cuts: [number, number][], speeds: { start: number; end: number; speed: number }[]): number {
  const marks = [...new Set([0, t, ...cuts.flat(), ...speeds.flatMap((r) => [r.start, r.end])])]
    .filter((x) => x >= 0 && x <= t)
    .sort((a, b) => a - b);
  let out = 0;
  for (let i = 0; i + 1 < marks.length; i++) {
    const [a, b] = [marks[i], marks[i + 1]];
    const mid = (a + b) / 2;
    if (cuts.some(([s, e]) => s <= mid && mid < e)) continue;
    const sp = speeds.find((r) => r.start <= mid && mid < r.end)?.speed ?? 1;
    out += (b - a) / sp;
  }
  return out;
}
