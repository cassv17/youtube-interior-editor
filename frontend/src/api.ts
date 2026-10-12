// 백엔드 API 타입과 호출 함수

export interface Clip {
  id: string;
  name: string;
  offset: number;
  duration: number;
  width: number;
  height: number;
}

export interface Cut {
  id: string;
  clip_id: string;
  start: number;
  end: number;
  origin: "silence" | "no-speech" | "user";
  enabled: boolean;
  mean_db?: number | null;
  needs_review: boolean;
  review_reasons: string[];
}

export interface Word {
  w: string;
  s: number;
  e: number;
  p: number;
}

export interface Subtitle {
  id: string;
  clip_id: string;
  start: number;
  end: number;
  text: string;
  needs_review: boolean;
  review_reasons: string[];
  words: Word[];
}

export interface Style {
  font: string;
  size: number;
  color: string;
  outline_color: string;
  outline: number;
  shadow: boolean;
  position: "bottom" | "top";
  margin: number;
}

export interface SilenceParams {
  threshold: "auto" | number;
  min_silence: number;
  pad: number;
}

export interface ClipAnalysis {
  noise_db: number | null;
  speech_db: number | null;
  threshold_db: number | null;
  low_confidence: boolean;
  note: string;
}

export interface Source {
  sid: string;
  name: string;
  duration: number;
  width: number;
  height: number;
}

export interface Job {
  stage: string;
  progress: number;
  detail: string;
}

export type FinishFormat = "burned" | "clean" | "premiere";

export interface ExportResult {
  folder: string;
  files: string[];
  formats: FinishFormat[];
  created: string;
}

export interface ExportJob {
  state: "queued" | "running" | "done" | "failed";
  progress: number;
  result: ExportResult | null;
  error: string;
  mode?: string;
}

export interface Group {
  id: string;
  name: string;
  clips: string[];
}

export interface SpeedRange {
  id: string;
  start: number;
  end: number;
  speed: number;
}

export interface RequestResult {
  available: boolean;
  note: string;
  silence: { min_silence: number; pad: number } | null;
  subtitle: { max_chars: number } | null;
  style: Partial<Pick<Style, "position" | "margin" | "size" | "color" | "outline_color">> | null;
  speed_all: number | null;
  terms: string[];
  unsupported: string[];
  applied: string[];
}

export type RequestPayload = { text: string } & Partial<Omit<RequestResult, "available" | "note" | "applied">>;

export interface RequestNote {
  text: string;
  applied: string[];
  unsupported: string[];
}

export interface ReferenceRhythm {
  ok: boolean;
  note: string;
  label?: "빠름" | "보통" | "느림";
  median_pause?: number;
  p90_pause?: number;
  pauses_per_min?: number;
  speech_ratio?: number;
  silence?: { min_silence: number; pad: number };
}

export interface ReferenceSubtitle {
  ok: boolean;
  note: string;
  confidence?: number;
  style?: Partial<Pick<Style, "position" | "margin" | "size" | "color" | "outline_color">>;
}

export interface ReferenceResult {
  name: string;
  duration: number;
  rhythm: ReferenceRhythm;
  subtitle: ReferenceSubtitle;
}

export interface ReferenceNote {
  name: string;
  rhythm_applied: boolean;
  style_applied: boolean;
  summary: string;
}

export interface Project {
  id: string;
  name: string;
  status: "uploaded" | "analyzing" | "ready" | "failed" | "completed";
  created: string;
  updated?: string;
  error?: string;
  sources: Source[];
  order?: string[];
  duration: number;
  clips: Clip[];
  cuts: Cut[];
  subtitles: Subtitle[];
  style: Style;
  silence_params: SilenceParams;
  clip_analysis: Record<string, ClipAnalysis>;
  output: { width: number; height: number; fps: number };
  job?: Job | null;
  export_job?: ExportJob | null;
  exports?: ExportResult[];
  groups?: Group[];
  speed_ranges?: SpeedRange[];
  request?: RequestNote;
  reference?: ReferenceNote;
  proxy?: string;
  // 완료된 작업(편집 기록은 지워지고 결과 정보만 남음)
  completed?: string;
  folder?: string;
  files?: string[];
  formats?: FinishFormat[];
  clip_count?: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: Project["status"];
  created: string;
  updated?: string;
  duration?: number;
  completed?: string;
  clips: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* 본문이 JSON이 아니면 상태 코드만 보여준다 */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  list: () => request<ProjectSummary[]>("/api/projects"),
  get: (id: string) => request<Project>(`/api/projects/${id}`),
  start: (id: string, order: string[], silence: SilenceParams, extra?: { style?: Partial<Style>; reference?: ReferenceNote; request?: RequestPayload }) =>
    request<{ ok: boolean }>(`/api/projects/${id}/start`, json("POST", { order, silence, ...extra })),
  interpretRequest: (text: string) =>
    request<RequestResult>("/api/request/interpret", json("POST", { text })),
  analyzeReference: (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<ReferenceResult>("/api/reference", { method: "POST", body: form });
  },
  saveEdits: (id: string, edits: { cuts: Cut[]; subtitles: Subtitle[]; speeds: SpeedRange[]; style: Style }) =>
    request<{ ok: boolean; updated: string }>(`/api/projects/${id}/edits`, json("PUT", edits)),
  redetect: (id: string, params: SilenceParams) =>
    request<Project>(`/api/projects/${id}/redetect`, json("POST", params)),
  waveform: (id: string) => request<{ frame_sec: number; db: number[] }>(`/api/projects/${id}/waveform`),
  // 미리보기 파일이 바뀌면 주소도 바뀌게 해서 브라우저가 예전 영상을 쓰지 않게 한다
  proxyUrl: (id: string, version?: string) => `/api/projects/${id}/proxy.mp4${version ? `?v=${encodeURIComponent(version)}` : ""}`,
  reproxy: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}/reproxy`, { method: "POST" }),
  export: (id: string, formats: FinishFormat[]) =>
    request<{ ok: boolean }>(`/api/projects/${id}/export`, json("POST", { formats })),
  openOutput: (path?: string) => request<{ ok: boolean }>("/api/open-output", json("POST", { path })),
  reorder: (id: string, order: string[], groups: Group[]) =>
    request<Project>(`/api/projects/${id}/reorder`, json("POST", { order, groups })),
  finalize: (id: string, formats: FinishFormat[]) =>
    request<{ ok: boolean }>(`/api/projects/${id}/finalize`, json("POST", { formats })),
  downloadUrl: (path: string) => `/api/download?path=${encodeURIComponent(path)}`,
};

/** 파일 업로드(진행률 표시를 위해 XMLHttpRequest 사용). */
export function uploadFiles(files: File[], onProgress: (frac: number) => void): Promise<Project> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/projects");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* 무시 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Project);
      else reject(new Error(body?.detail || `업로드 실패 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("업로드 중 연결이 끊겼습니다. 프로그램이 실행 중인지 확인하세요."));
    xhr.send(form);
  });
}
