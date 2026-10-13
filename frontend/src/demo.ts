// 체험(데모) 모드: 서버 없이 가짜 샘플 프로젝트 하나로 편집 화면을 둘러볼 수 있다.
// npm run build:demo 로 만든 배포본에서만 켜진다. 실제 영상·자막은 들어 있지 않고, 저장·내보내기·업로드는 막혀 있다.
import type { Project, ProjectSummary } from "./api";
import { defaultTracks } from "./layers";

export const DEMO = import.meta.env.VITE_DEMO === "1";
export const DEMO_ID = "demo-sample";
export const DEMO_MSG = "체험 버전에서는 사용할 수 없는 기능입니다. 내려받아 내 PC에서 실행하면 모두 쓸 수 있습니다.";

const DURATION = 32;
const SPEECH: [number, number][] = [[0, 5.5], [8, 13.5], [16, 21.5], [24, 29.5]];
const LINES = [
  "안녕하세요, 영상 자동편집 체험 화면입니다",
  "무음 구간은 자동으로 잘라 줍니다",
  "자막도 자동으로 만들어 타임라인에서 고칠 수 있어요",
  "조각을 끌어 순서를 바꾸고 레이어를 쌓아 보세요",
];

const words = (text: string, s: number, e: number) => {
  const ws = text.split(" ");
  const step = (e - s) / ws.length;
  return ws.map((w, i) => ({ w, s: +(s + i * step).toFixed(2), e: +(s + (i + 1) * step).toFixed(2), p: 0.95 }));
};

export const demoSummary = (): ProjectSummary[] => [
  { id: DEMO_ID, name: "샘플 프로젝트 (체험용)", status: "ready", created: "2026-01-01T00:00:00", updated: "2026-01-01T00:00:00", duration: DURATION, clips: 1 },
];

export function demoProject(): Project {
  const silence: [number, number][] = [[5.5, 8], [13.5, 16], [21.5, 24], [29.5, 32]];
  return {
    id: DEMO_ID,
    name: "샘플 프로젝트 (체험용)",
    status: "ready",
    created: "2026-01-01T00:00:00",
    updated: "2026-01-01T00:00:00",
    sources: [{ sid: "s1", name: "sample.mp4", duration: DURATION, width: 854, height: 480 }],
    order: ["s1"],
    duration: DURATION,
    clips: [{ id: "c1", name: "sample.mp4", offset: 0, duration: DURATION, width: 854, height: 480, has_audio: true }],
    cuts: silence.map(([start, end], i) => ({
      id: `cut-${i}`, clip_id: "c1", start, end, origin: "silence" as const, enabled: true, mean_db: -70, needs_review: false, review_reasons: [],
    })),
    subtitles: SPEECH.map(([start, end], i) => ({
      id: `sub-${i}`, clip_id: "c1", start: start + 0.2, end: end - 0.2, text: LINES[i], needs_review: false, review_reasons: [],
      words: words(LINES[i], start + 0.2, end - 0.2),
    })),
    style: { font: "Malgun Gothic", size: 56, color: "#ffffff", outline_color: "#000000", outline: 3, shadow: true, position: "bottom", margin: 40 },
    silence_params: { threshold: "auto", min_silence: 0.6, pad: 0.15 },
    clip_analysis: { c1: { noise_db: -70, speech_db: -24, threshold_db: -46, low_confidence: false, note: "" } },
    output: { width: 854, height: 480, fps: 30 },
    speed_ranges: [],
    splits: [],
    layout: [],
    tracks: defaultTracks(),
    overlays: [],
    markers: [],
    assets: [],
    proxy: "demo",
  };
}

/** 말하는 구간은 크게, 무음 구간은 작게 보이는 가짜 파형 */
export function demoWave(): { frame_sec: number; db: number[] } {
  const frame_sec = 0.05;
  const db: number[] = [];
  for (let i = 0; i < DURATION / frame_sec; i++) {
    const t = i * frame_sec;
    const speaking = SPEECH.some(([s, e]) => t >= s && t < e);
    db.push(speaking ? -22 + Math.sin(i * 0.9) * 6 : -72 + Math.sin(i * 1.3) * 2);
  }
  return { frame_sec, db };
}
