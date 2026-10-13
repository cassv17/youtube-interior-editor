import { useEffect, useRef } from "react";
import type { Asset, Clip } from "./api";
import { api } from "./api";
import { fadeFactor, fitSize, isActive, type Overlay, type Track } from "./layers";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  rect: Rect;
  time: number; // 결과 영상 시간(초)
  playing: boolean;
  projectId: string;
  proxySrc: string; // 원본 영상 조각 레이어가 쓰는 미리보기 파일
  tracks: Track[];
  overlays: Overlay[];
  assets: Asset[];
  clips: Clip[];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 결과 배치 보기의 레이어 미리보기: 메인 영상 위에 영상·이미지 레이어를 쌓고, 음악 레이어를 함께 재생한다. 위 트랙이 앞에 보인다. */
export default function LayerStage(p: Props) {
  const tmap = new Map(p.tracks.map((t) => [t.id, t]));
  const assets = new Map(p.assets.map((a) => [a.id, a]));
  const clips = new Map(p.clips.map((c) => [c.id, c]));
  // 영상 트랙을 아래 → 위 순서로 번호를 매겨 z-index에 쓴다(메인 영상이 맨 아래)
  const videoOrder = [...p.tracks.filter((t) => t.kind === "video")].reverse().map((t) => t.id);

  return (
    <>
      {p.overlays.map((o) => {
        const t = tmap.get(o.track);
        if (!t) return null;
        if (t.kind === "audio" ? t.muted : t.hidden) return null;
        const asset = o.type === "clip" ? null : assets.get(o.src);
        const clip = o.type === "clip" ? clips.get(o.src) : null;
        if (!asset && !clip) return null;
        const src = clip ? p.proxySrc : api.assetUrl(p.projectId, o.src);
        const aspect = clip ? clip.width / clip.height : asset && asset.height ? asset.width / asset.height : 1;
        const mediaOffset = clip ? clip.offset : 0; // 미리보기 파일 안 위치(원본 영상 조각은 이어 붙인 파일 기준)
        const trackVolume = t.kind === "audio" ? (t.volume ?? 1) : 1;
        return (
          <LayerMedia
            key={o.id}
            item={o}
            src={src}
            aspect={aspect}
            mediaOffset={mediaOffset}
            trackVolume={trackVolume}
            z={1 + Math.max(0, videoOrder.indexOf(o.track))}
            {...p}
          />
        );
      })}
    </>
  );
}

function LayerMedia(p: Props & { item: Overlay; src: string; aspect: number; mediaOffset: number; trackVolume: number; z: number }) {
  const o = p.item;
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const active = isActive(o, p.time);
  const isAudio = o.type === "audio";
  const isImage = o.type === "image";
  const fade = fadeFactor(o, p.time);

  useEffect(() => {
    const el = ref.current;
    if (!el || isImage) return;
    if (!active) {
      if (!el.paused) el.pause();
      return;
    }
    const want = p.mediaOffset + o.src_in + (p.time - o.start);
    if (Math.abs(el.currentTime - want) > (p.playing ? 0.3 : 0.03)) el.currentTime = want;
    el.volume = clamp01(o.volume * fade * p.trackVolume); // 브라우저는 100%까지만 낼 수 있다(내보내기는 최대 200%)
    if (p.playing && el.paused) void el.play().catch(() => {});
    if (!p.playing && !el.paused) el.pause();
  }, [p.time, p.playing, active, o.volume, o.src_in, o.start, fade, p.trackVolume, p.mediaOffset, isImage]);

  if (isAudio) return <audio ref={ref} src={p.src} preload="auto" />;

  const fit = fitSize(p.aspect, p.rect.w, p.rect.h);
  const scale = o.scale ?? 1;
  const style: React.CSSProperties = {
    position: "absolute",
    left: p.rect.x + (o.x ?? 0.5) * p.rect.w,
    top: p.rect.y + (o.y ?? 0.5) * p.rect.h,
    width: fit.w * scale,
    height: fit.h * scale,
    transform: "translate(-50%, -50%)",
    opacity: (o.opacity ?? 1) * fade,
    display: active ? "block" : "none",
    zIndex: p.z,
    pointerEvents: "none",
    objectFit: "contain",
  };
  return isImage ? <img src={p.src} alt="" style={style} /> : <video ref={ref} src={p.src} preload="auto" playsInline style={style} />;
}
