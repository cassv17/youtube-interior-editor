import { forwardRef, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Style } from "./api";

export interface PreviewSub {
  id: string;
  text: string;
  style: Style;
  z: number; // 자막 레이어 순서: 클수록(위 레이어) 앞에 보인다
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  src: string;
  aspect: number; // 가로/세로
  subs: PreviewSub[];
  inCut: boolean;
  speed: number; // 지금 위치의 배속(1이면 표시 안 함)
  blank?: boolean; // 결과 배치의 빈칸: 영상 대신 검은 화면
  blankLabel?: boolean; // 빈칸 안내 문구를 보일지(레이어가 화면에 있으면 숨김)
  layers?: (rect: Rect) => ReactNode; // 메인 영상 위에 얹는 레이어(영상·이미지)
  onClick: () => void;
}

/** 영상 + 레이어 + 자막 미리보기. 자막은 내보내기와 같은 비율(영상 높이 대비 %)로 그리고, 위 레이어가 앞에 온다. */
const VideoPreview = forwardRef<HTMLVideoElement, Props>(function VideoPreview(p, ref) {
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });

  // 영상이 실제로 그려지는 영역(여백 제외)을 계산해 자막·레이어 위치를 맞춘다
  useLayoutEffect(() => {
    const el = box.current!;
    const calc = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      const w = Math.min(W, H * p.aspect);
      const h = w / p.aspect;
      setRect({ x: (W - w) / 2, y: (H - h) / 2, w, h });
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.aspect]);

  return (
    <div className="video-box" ref={box} onClick={p.onClick}>
      <video ref={ref} src={p.src} preload="auto" playsInline style={p.blank ? { visibility: "hidden" } : undefined} />
      {p.blank && p.blankLabel !== false && <div className="blank-flag">빈칸 (검은 화면 · 무음)</div>}
      {p.layers?.(rect)}
      {p.inCut && <div className="cut-flag">✂ 잘릴 구간</div>}
      {p.speed !== 1 && !p.inCut && <div className="cut-flag speed-flag">⏩ {p.speed}배속</div>}
      {p.subs.map((sub) => {
        const s = sub.style;
        const font = (rect.h * s.size) / 100;
        const stroke = Math.max(0, font * s.outline);
        const margin = (rect.h * s.margin) / 100;
        return (
          <div
            key={sub.id}
            className="sub-overlay"
            style={{
              left: rect.x,
              width: rect.w,
              zIndex: 20 + sub.z,
              [s.position === "top" ? "top" : "bottom"]: rect.y + margin,
              fontFamily: `"${s.font}", "Malgun Gothic", sans-serif`,
              fontSize: font,
              color: s.color,
              WebkitTextStroke: stroke ? `${stroke * 2}px ${s.outline_color}` : undefined,
              paintOrder: "stroke fill",
              textShadow: s.shadow ? `0 ${font * 0.05}px ${font * 0.12}px rgba(0,0,0,0.6)` : "none",
            }}
          >
            {sub.text}
          </div>
        );
      })}
    </div>
  );
});

export default VideoPreview;
