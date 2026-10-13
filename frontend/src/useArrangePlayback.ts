import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { eToP, type Atom, type Placed } from "./layout";

/**
 * 결과 배치 보기의 재생. 미리보기 영상은 원본 순서 그대로 한 파일이므로,
 * 결과 시간(E)에 맞춰 조각마다 영상 위치를 옮기고(순서 바꿈), 빈칸에서는 영상을 멈추고 화면을 검게 하며 시계만 흐르게 한다.
 */
export function useArrangePlayback(video: RefObject<HTMLVideoElement | null>, placed: Placed[], total: number, active: boolean) {
  const [time, setTime] = useState(0); // 결과 시간(초)
  const [playing, setPlaying] = useState(false);
  const [blank, setBlank] = useState(false); // 빈칸(또는 끝 이후)이라 검은 화면
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const totalRef = useRef(total);
  totalRef.current = total;
  const playingRef = useRef(false);
  playingRef.current = playing;
  const timeRef = useRef(0);
  const mode = useRef<"video" | "gap">("gap");
  const cur = useRef<{ atom: Atom; index: number } | null>(null);
  const last = useRef(0);
  const timer = useRef(0);

  const flat = useCallback(() => placedRef.current.flatMap((it) => it.atoms), []);

  const setT = (t: number) => {
    timeRef.current = t;
    setTime(t);
  };

  const stopTimer = () => {
    clearInterval(timer.current);
    timer.current = 0;
  };

  /** 결과 시간 e로 이동(재생 상태는 그대로) */
  const seek = useCallback((e: number) => {
    const t = Math.max(0, Math.min(e, totalRef.current));
    setT(t);
    const v = video.current;
    const hit = eToP(placedRef.current, t);
    if (hit && v) {
      v.currentTime = hit.p;
      v.playbackRate = hit.atom.speed;
      const list = flat();
      cur.current = { atom: hit.atom, index: list.indexOf(hit.atom) };
      mode.current = "video";
      setBlank(false);
      if (playingRef.current) void v.play().catch(() => {});
    } else {
      cur.current = null;
      mode.current = "gap";
      setBlank(true);
      v?.pause();
    }
  }, [video, flat]);

  const startVideoAt = useCallback((atom: Atom, index: number, atP: number) => {
    const v = video.current;
    if (!v) return;
    cur.current = { atom, index };
    mode.current = "video";
    v.currentTime = atP;
    v.playbackRate = atom.speed;
    setBlank(false);
    void v.play().catch(() => {});
  }, [video]);

  const tick = useCallback(() => {
    const v = video.current;
    const list = flat();
    const now = performance.now();
    const dt = (now - last.current) / 1000;
    last.current = now;

    if (mode.current === "video" && cur.current && v) {
      const { atom, index } = cur.current;
      const r = (atom.e1 - atom.e0) / (atom.b - atom.a);
      let t = atom.e0 + (v.currentTime - atom.a) * r;
      if (t >= atom.e1 - 0.012 || v.ended) {
        const next = list[index + 1];
        if (!next) {
          v.pause();
          setT(totalRef.current);
          setPlaying(false);
          setBlank(true);
          mode.current = "gap";
          stopTimer();
          return;
        }
        if (next.e0 <= atom.e1 + 0.012) {
          // 이어지는 조각: 원본에서도 이어지면 그대로 두고 속도만 바꾼다
          if (Math.abs(next.a - atom.b) > 0.02) v.currentTime = next.a;
          v.playbackRate = next.speed;
          cur.current = { atom: next, index: index + 1 };
          t = next.e0;
        } else {
          v.pause(); // 빈칸: 검은 화면 + 시계만 진행
          mode.current = "gap";
          cur.current = { atom, index }; // 다음 조각을 찾기 위한 기준
          setBlank(true);
          t = atom.e1;
        }
      }
      setT(t);
      return;
    }

    // 빈칸(또는 시작 전)
    const t = timeRef.current + dt;
    const next = list.find((a) => a.e0 >= timeRef.current - 1e-9) ?? null;
    if (next && t >= next.e0 - 0.012) {
      setT(next.e0);
      startVideoAt(next, list.indexOf(next), next.a);
      return;
    }
    if (!next || t >= totalRef.current) {
      setT(totalRef.current);
      setPlaying(false);
      stopTimer();
      return;
    }
    setT(t);
  }, [video, flat, startVideoAt]);

  const play = useCallback(() => {
    if (!active) return;
    if (timeRef.current >= totalRef.current - 0.02) seek(0);
    last.current = performance.now();
    setPlaying(true);
    const hit = eToP(placedRef.current, timeRef.current);
    if (hit) {
      const list = flat();
      startVideoAt(hit.atom, list.indexOf(hit.atom), hit.p);
    } else {
      mode.current = "gap";
      setBlank(true);
    }
    stopTimer();
    timer.current = window.setInterval(tick, 25);
  }, [active, flat, seek, startVideoAt, tick]);

  const pause = useCallback(() => {
    stopTimer();
    setPlaying(false);
    video.current?.pause();
  }, [video]);

  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);

  // 보기를 벗어나거나 화면을 떠나면 멈춘다
  useEffect(() => {
    if (!active) pause();
  }, [active, pause]);
  useEffect(() => () => stopTimer(), []);

  /** 배치가 바뀐 뒤에도 같은 위치를 보여 주기 위해 시간을 다시 맞춘다 */
  const setTime0 = useCallback((e: number) => {
    setT(Math.max(0, e));
    const hit = eToP(placedRef.current, e);
    setBlank(!hit);
  }, []);

  return { time, playing, blank, seek, play, pause, toggle, setTime: setTime0 };
}
