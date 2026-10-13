import { useRef, useState } from "react";

/** 입력 중에는 그대로 두고, Enter나 포커스 이동 시에 반영한다. */
export function NumField({ value, onCommit, digits = 2 }: { value: number; onCommit: (v: string) => void; digits?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      type="number"
      step={0.1}
      value={draft ?? value.toFixed(digits)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

/**
 * 슬라이더. 끄는 동안의 변경은 한 번의 되돌리기로 묶는다(begin/end).
 * onChange의 두 번째 값(record)은 끄는 중이면 false, 키보드 조작이면 true.
 */
export function Slider(p: {
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number, record: boolean) => void;
  begin: () => void;
  end: () => void;
}) {
  const dragging = useRef(false);
  return (
    <span className="slider">
      <input
        type="range"
        min={p.min}
        max={p.max}
        step={p.step ?? 1}
        value={p.value}
        onPointerDown={() => {
          dragging.current = true;
          p.begin();
        }}
        onPointerUp={() => {
          dragging.current = false;
          p.end();
        }}
        onChange={(e) => p.onChange(+e.target.value, !dragging.current)}
      />
      <output>{p.format ? p.format(p.value) : p.value}</output>
    </span>
  );
}

export function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [v, setV] = useState<string | null>(null);
  return <input type="color" value={v ?? value} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v) onChange(v); setV(null); }} />;
}
