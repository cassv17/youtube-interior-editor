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
