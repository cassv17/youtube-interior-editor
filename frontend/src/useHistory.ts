import { useCallback, useRef, useState } from "react";

const LIMIT = 200;

/**
 * 되돌리기/다시하기가 되는 상태.
 * - set(next): 한 번의 변경으로 기록
 * - 드래그처럼 연속 변경은 begin() → set(next, false) 반복 → end() 로 한 번만 기록
 */
export function useHistory<T>(initial: T) {
  const [present, setPresent] = useState(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const gestureBase = useRef<T | null>(null);
  const presentRef = useRef(present);
  presentRef.current = present;
  const [, force] = useState(0);

  const push = (base: T) => {
    past.current.push(base);
    if (past.current.length > LIMIT) past.current.shift();
    future.current = [];
  };

  const set = useCallback((next: T | ((prev: T) => T), record = true) => {
    const value = typeof next === "function" ? (next as (p: T) => T)(presentRef.current) : next;
    if (record && gestureBase.current === null) push(presentRef.current);
    presentRef.current = value;
    setPresent(value);
  }, []);

  const begin = useCallback(() => {
    if (gestureBase.current === null) gestureBase.current = presentRef.current;
  }, []);

  const end = useCallback(() => {
    const base = gestureBase.current;
    gestureBase.current = null;
    if (base !== null && base !== presentRef.current) {
      push(base);
      force((n) => n + 1);
    }
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(presentRef.current);
    presentRef.current = prev;
    setPresent(prev);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(presentRef.current);
    presentRef.current = next;
    setPresent(next);
  }, []);

  /** 서버에서 새로 받은 상태로 교체(되돌리기 기록은 남긴다). */
  const replace = useCallback((value: T) => {
    push(presentRef.current);
    presentRef.current = value;
    setPresent(value);
  }, []);

  return {
    present,
    set,
    begin,
    end,
    undo,
    redo,
    replace,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
