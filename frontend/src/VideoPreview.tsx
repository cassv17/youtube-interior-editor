import { forwardRef, useLayoutEffect, useRef, useState } from "react";
import type { Style, Subtitle } from "./api";

interface Props {
  src: string;
  aspect: number; // 가로/세로
  style: Style;
  subtitle: Subtitle | null;
  inCut: boolean;
  onClick: () => void;
}

/** 영상 + 자막 미리보기. 자막은 내보내기와 같은 비율(영상 높이 대비 %)로 그린다. */
const VideoPreview = forwardRef<HTMLVideoElement, Props>(function VideoPreview(p, ref) {
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState({ x: 0, y: 0, w: 0, h: 0 });

  // 영상이 실제로 그려지는 영역(여백 제외)을 계산해 자막 위치를 맞춘다
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

  const s = p.style;
  const font = (rect.h * s.size) / 100;
  const stroke = Math.max(0, font * s.outline);
  const margin = (rect.h * s.margin) / 100;

  return (
    <div className="video-box" ref={box} onClick={p.onClick}>
      <video ref={ref} src={p.src} preload="auto" playsInline />
      {p.inCut && <div className="cut-flag">✂ 잘릴 구간</div>}
      {p.subtitle && (
        <div
          className="sub-overlay"
          style={{
            left: rect.x,
            width: rect.w,
            [s.position === "top" ? "top" : "bottom"]: rect.y + margin,
            fontFamily: `"${s.font}", "Malgun Gothic", sans-serif`,
            fontSize: font,
            color: s.color,
            WebkitTextStroke: stroke ? `${stroke * 2}px ${s.outline_color}` : undefined,
            paintOrder: "stroke fill",
            textShadow: s.shadow ? `0 ${font * 0.05}px ${font * 0.12}px rgba(0,0,0,0.6)` : "none",
          }}
        >
          {p.subtitle.text}
        </div>
      )}
    </div>
  );
});

export default VideoPreview;
