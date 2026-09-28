import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Cut, type Group, type Project, type SilenceParams } from "./api";
import ExportDialog from "./ExportDialog";
import Inspector, { type EditDoc } from "./Inspector";
import Timeline, { newCut, newSub, type Doc, type Selection } from "./Timeline";
import { useHistory } from "./useHistory";
import VideoPreview from "./VideoPreview";
import { clamp, fmt, snap, uid } from "./time";

type SaveState = "saved" | "pending" | "saving" | "error";

/** 겹치는 컷을 합친 '실제로 잘릴 구간' 목록 */
function mergedCuts(cuts: Cut[]): [number, number][] {
  const on = cuts.filter((c) => c.enabled).map((c) => [c.start, c.end] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of on) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1e-6) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

interface EditorProps {
  project: Project;
  onBack: () => void;
  onReload: () => void; // 클립 순서가 바뀌어 미리보기를 다시 만들 때 상태를 새로 불러온다
  onFinished: () => void; // 완료 처리 후
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export default function Editor({ project, onBack, onReload, onFinished }: EditorProps) {
  const hist = useHistory<EditDoc>({ cuts: project.cuts, subtitles: project.subtitles, style: project.style });
  const doc = hist.present;
  const [meta, setMeta] = useState(project); // 클립 분석값·무음 설정 등 (재감지 시 갱신)
  const [wave, setWave] = useState<{ frame_sec: number; db: number[] } | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [skipCuts, setSkipCuts] = useState(true);
  const [pps, setPps] = useState(40);
  const [save, setSave] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<string>(project.updated ? project.updated.slice(11, 16) : "");
  const [groups, setGroups] = useState<Group[]>(project.groups ?? []);
  const [selectedClips, setSelectedClips] = useState<string[]>([]);
  const [finishing, setFinishing] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [exporting, setExporting] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  const cutsMerged = useMemo(() => mergedCuts(doc.cuts), [doc.cuts]);
  const removed = cutsMerged.reduce((a, [s, e]) => a + (e - s), 0);
  const resultDuration = project.duration - removed;
  const inCut = cutsMerged.find(([s, e]) => time >= s && time < e);
  const currentSub = doc.subtitles.find((s) => time >= s.start && time < s.end) ?? null;

  useEffect(() => {
    api.waveform(project.id).then(setWave).catch(() => setWave(null));
  }, [project.id]);

  // ---------- 자동 저장 (변경 0.8초 뒤) ----------
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSave("pending");
    const timer = setTimeout(async () => {
      setSave("saving");
      try {
        await api.saveEdits(project.id, doc);
        setSave("saved");
        setSavedAt(hhmm(new Date()));
        setSaveErr("");
      } catch (e) {
        setSave("error");
        setSaveErr((e as Error).message);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [doc, project.id]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (save !== "saved") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save]);

  // ---------- 재생: 재생 위치 추적 + 컷 건너뛰기 ----------
  const cutsRef = useRef(cutsMerged);
  cutsRef.current = cutsMerged;
  const skipRef = useRef(skipCuts);
  skipRef.current = skipCuts;
  useEffect(() => {
    const v = video.current!;
    let timer = 0;
    // 재생 중에만 25ms마다 확인한다(정지 상태에서는 이벤트로만 갱신).
    // requestAnimationFrame은 창이 가려지면 멈춰서 컷 건너뛰기를 놓칠 수 있어 타이머를 쓴다.
    const tick = () => {
      let t = v.currentTime;
      if (skipRef.current) {
        const hit = cutsRef.current.find(([s, e]) => t >= s && t < e - 0.02);
        if (hit) {
          v.currentTime = hit[1];
          t = hit[1];
        }
      }
      setTime(t);
    };
    const onPlay = () => {
      setPlaying(true);
      clearInterval(timer);
      timer = window.setInterval(tick, 25);
    };
    const onStop = () => {
      setPlaying(false);
      clearInterval(timer);
      setTime(v.currentTime);
    };
    const onSeek = () => setTime(v.currentTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onStop);
    v.addEventListener("ended", onStop);
    v.addEventListener("seeking", onSeek);
    v.addEventListener("seeked", onSeek);
    return () => {
      clearInterval(timer);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onStop);
      v.removeEventListener("ended", onStop);
      v.removeEventListener("seeking", onSeek);
      v.removeEventListener("seeked", onSeek);
    };
  }, []);

  const seek = useCallback((t: number) => {
    const v = video.current;
    if (v) v.currentTime = clamp(t, 0, project.duration);
  }, [project.duration]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const playFrom = useCallback((t: number) => {
    seek(t);
    video.current?.play();
  }, [seek]);

  // ---------- 편집 동작 ----------
  const updateTimeline = useCallback(
    (fn: (d: Doc) => Doc, record = true) => hist.set((prev) => ({ ...prev, ...fn(prev) }), record),
    [hist.set],
  );

  const deleteSelected = useCallback(() => {
    if (!selection) return;
    hist.set((d) =>
      selection.kind === "cut"
        ? { ...d, cuts: d.cuts.filter((c) => c.id !== selection.id) }
        : { ...d, subtitles: d.subtitles.filter((s) => s.id !== selection.id) },
    );
    setSelection(null);
  }, [selection, hist.set]);

  const addCut = () => {
    const t = snap(time);
    const id = uid("cut");
    hist.set((d) => ({ ...d, cuts: [...d.cuts, newCut(id, t, Math.min(t + 1, project.duration))] }));
    setSelection({ kind: "cut", id });
  };

  const addSub = () => {
    const t = snap(time);
    const next = doc.subtitles.filter((s) => s.start > t).map((s) => s.start);
    const inside = doc.subtitles.some((s) => t >= s.start && t < s.end);
    const end = Math.min(t + 2, project.duration, ...next);
    if (inside || end - t < 0.3) {
      alert("이 위치에는 이미 자막이 있거나 공간이 부족합니다. 빈 곳으로 이동한 뒤 추가하세요.");
      return;
    }
    const id = uid("sub");
    hist.set((d) => ({ ...d, subtitles: [...d.subtitles, newSub(id, t, end)].sort((a, b) => a.start - b.start) }));
    setSelection({ kind: "sub", id });
  };

  const redetect = async (params: SilenceParams) => {
    const p = await api.redetect(project.id, params);
    setMeta(p);
    hist.replace({ ...doc, cuts: p.cuts });
  };

  // ---------- 단축키 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) hist.redo();
        else hist.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        hist.redo();
        return;
      }
      if (typing) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "ArrowLeft") {
        seek((video.current?.currentTime ?? 0) - (e.shiftKey ? 1 / 30 : 1));
      } else if (e.key === "ArrowRight") {
        seek((video.current?.currentTime ?? 0) + (e.shiftKey ? 1 / 30 : 1));
      } else if (e.key === "Escape") {
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hist.undo, hist.redo, togglePlay, deleteSelected, seek]);

  const fitAll = () => {
    const w = document.querySelector(".tl-scroll")?.clientWidth ?? 1000;
    setPps(clamp((w - 20) / project.duration, 2, 600));
  };

  const saveLabel = {
    saved: savedAt ? `임시저장됨 ${savedAt}` : "임시저장됨",
    pending: "변경됨…",
    saving: "저장 중…",
    error: "저장 실패",
  }[save];

  /** 편집 내용을 즉시 서버에 저장(임시저장 버튼, 내보내기·순서 변경 전) */
  const flush = useCallback(async () => {
    setSave("saving");
    try {
      await api.saveEdits(project.id, doc);
      setSave("saved");
      setSavedAt(hhmm(new Date()));
      setSaveErr("");
    } catch (e) {
      setSave("error");
      setSaveErr((e as Error).message);
      throw e;
    }
  }, [project.id, doc]);

  // ---------- 클립 순서·그룹 ----------
  const applyOrder = async (order: string[], nextGroups: Group[]) => {
    const changed = order.join() !== project.clips.map((c) => c.id).join();
    if (changed) {
      const sec = Math.max(5, Math.round(project.duration * 0.1));
      if (!confirm(`클립 순서를 바꿉니다. 각 클립의 컷과 자막도 함께 옮겨집니다.
미리보기 영상을 다시 만드는 데 약 ${sec}초 걸립니다. 진행할까요?`)) return;
    }
    video.current?.pause();
    try {
      await flush();
      const p = await api.reorder(project.id, order, nextGroups);
      setGroups(p.groups ?? []);
      if (changed) onReload();
    } catch (e) {
      alert(`순서/그룹을 바꾸지 못했습니다: ${(e as Error).message}`);
    }
  };

  const makeGroup = () => {
    if (selectedClips.length < 2) return;
    const order = project.clips.map((c) => c.id);
    // 이미 그룹에 속한 클립을 고르면 그 그룹 전체를 새 그룹에 합친다
    const touched = groups.filter((g) => g.clips.some((c) => selectedClips.includes(c)));
    const members = new Set([...selectedClips, ...touched.flatMap((g) => g.clips)]);
    const first = order.findIndex((id) => members.has(id));
    const rest = order.filter((id) => !members.has(id));
    const inGroup = order.filter((id) => members.has(id));
    const before = rest.filter((id) => order.indexOf(id) < first);
    const after = rest.filter((id) => order.indexOf(id) > first);
    const newOrder = [...before, ...inGroup, ...after];
    const name = prompt("그룹 이름을 입력하세요 (예: 거실, 주방)", `그룹 ${groups.length + 1}`);
    if (name === null) return;
    const next = [...groups.filter((g) => !touched.includes(g)), { id: `g${Date.now().toString(36)}`, name: name || `그룹 ${groups.length + 1}`, clips: inGroup }];
    applyOrder(newOrder, next);
  };

  const ungroup = () => {
    const next = groups.filter((g) => !g.clips.some((c) => selectedClips.includes(c)));
    applyOrder(project.clips.map((c) => c.id), next);
  };

  const renameGroup = (id: string) => {
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    const name = prompt("그룹 이름", g.name);
    if (!name) return;
    applyOrder(project.clips.map((c) => c.id), groups.map((x) => (x.id === id ? { ...x, name } : x)));
  };

  return (
    <div className="editor-page">
      <header className="topbar">
        <button className="link" onClick={onBack}>← 프로젝트 목록</button>
        <h1>{project.name}</h1>
        <span className={`save ${save}`} title={saveErr || "편집 내용은 자동으로도 저장됩니다"}>{saveLabel}{save === "error" ? ` — ${saveErr}` : ""}</span>
        <div className="spacer" />
        <button onClick={hist.undo} disabled={!hist.canUndo} title="Ctrl+Z">↶ 되돌리기</button>
        <button onClick={hist.redo} disabled={!hist.canRedo} title="Ctrl+Shift+Z">↷ 다시하기</button>
        <button onClick={() => flush().catch(() => {})} title="지금 상태를 저장합니다. 첫 화면 '작업 중' 목록에서 언제든 이어서 할 수 있습니다.">💾 임시저장</button>
        <button onClick={() => { video.current?.pause(); setExporting(true); }} title="작업은 그대로 두고 결과 영상만 뽑아 봅니다">내보내기</button>
        <button className="primary" onClick={() => { video.current?.pause(); setFinishing(true); }} title="최종 파일을 만들고 작업을 마칩니다">✔ 완료</button>
      </header>

      <div className="main">
        <section className="player">
          <VideoPreview
            ref={video}
            src={api.proxyUrl(project.id, project.proxy)}
            aspect={project.output.width / project.output.height}
            style={doc.style}
            subtitle={currentSub}
            inCut={!!inCut && !skipCuts}
            onClick={togglePlay}
          />
          <div className="controls">
            <button className="play" onClick={togglePlay}>{playing ? "❚❚" : "▶"}</button>
            <span className="clock">{fmt(time, 2)} / {fmt(project.duration, 1)}</span>
            <label className="check">
              <input type="checkbox" checked={skipCuts} onChange={(e) => setSkipCuts(e.target.checked)} />
              컷 적용해서 보기 (잘릴 구간 건너뛰기)
            </label>
            <span className="result">결과 길이 <b>{fmt(resultDuration)}</b> ({removed.toFixed(1)}초 제거)</span>
          </div>
        </section>
        <Inspector
          doc={doc}
          duration={project.duration}
          resultDuration={resultDuration}
          clips={meta.clips}
          analysis={meta.clip_analysis}
          silence={meta.silence_params}
          selection={selection}
          time={time}
          update={(fn, record) => hist.set(fn, record)}
          begin={hist.begin}
          end={hist.end}
          onSelect={setSelection}
          onPlayFrom={playFrom}
          onAddCut={addCut}
          onAddSub={addSub}
          onRedetect={redetect}
        />
      </div>

      {(exporting || finishing) && (
        <ExportDialog
          mode={finishing ? "finish" : "export"}
          onFinished={onFinished}
          projectId={project.id}
          resultDuration={resultDuration}
          cutCount={cutsMerged.length}
          subCount={doc.subtitles.length}
          reviewLeft={doc.cuts.filter((c) => c.needs_review && c.enabled).length + doc.subtitles.filter((s) => s.needs_review).length}
          flush={flush}
          onClose={() => { setExporting(false); setFinishing(false); }}
        />
      )}

      <div className="tl-bar">
        <span>확대</span>
        <input type="range" min={2} max={300} value={pps} onChange={(e) => setPps(+e.target.value)} />
        <button onClick={fitAll}>전체 보기</button>
        {selectedClips.length > 0 ? (
          <span className="clip-tools">
            클립 {selectedClips.length}개 선택
            <button onClick={makeGroup} disabled={selectedClips.length < 2} title="Ctrl+클릭으로 2개 이상 고르세요">🔗 그룹으로 묶기</button>
            <button onClick={ungroup} disabled={!groups.some((g) => g.clips.some((c) => selectedClips.includes(c)))}>그룹 풀기</button>
            <button onClick={() => setSelectedClips([])}>선택 해제</button>
          </span>
        ) : (
          <span>클립: 끌어서 순서 변경 · Ctrl+클릭으로 여러 개 선택 후 그룹</span>
        )}
        <span className="legend">
          <i className="lg-cut" /> 잘릴 구간 <i className="lg-off" /> 제안(꺼짐, 더블클릭으로 적용) <i className="lg-review" /> 확인 필요
        </span>
      </div>
      <Timeline
        duration={project.duration}
        clips={project.clips}
        doc={doc}
        wave={wave}
        time={time}
        playing={playing}
        pps={pps}
        setPps={setPps}
        selection={selection}
        onSelect={setSelection}
        onSeek={seek}
        update={updateTimeline}
        begin={hist.begin}
        end={hist.end}
        groups={groups}
        selectedClips={selectedClips}
        onSelectClips={setSelectedClips}
        onReorder={(order) => applyOrder(order, groups)}
        onRenameGroup={renameGroup}
      />
    </div>
  );
}
