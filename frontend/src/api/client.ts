/** 与本地 Python 桥接服务（backend/backend.py）通信的 API 客户端。 */

export interface HealthInfo {
  algorithm: string;
  architecture: string;
  algorithm_commit: string;
  model_loaded: boolean;
  wrapper: string | null;
  model_path: string | null;
  confidence_threshold: number;
  expected_epoch_shape: number[];
  sample_rate_hz: number;
  window_seconds: number[];
  error: string | null;
  fallback?: {
    engine: string;
    trained: boolean;
    train_samples: number;
    holdout_accuracy: number | null;
    error: string | null;
  };
}

export interface SourceMeta {
  id: string;
  name: string;
  extension: string;
  size_bytes: number;
  uploaded_at: string;
  state: string;
  source_mode: string;
  epoch_count: number;
  event_count?: number;
  symbol_count?: number;
  decoded_text?: string;
  decoded_morse?: string;
  unknown_sequences?: string[];
  correction?: CorrectionPayload | null;
  parse_error?: string | null;
  channels: string[];
  sample_rate_hz: number;
  epoch_shape: number[];
  window?: WindowConfig;
  labels?: Array<0 | 1> | null;
  label_counts?: { left: number; right: number };
  preview_epoch?: number[][];
  duration_s?: number;
  first_prediction?: PredictResult;
  prediction_error?: string;
}

export interface CorrectionPayload {
  original: string;
  suggested: string;
  confidence: number;
  edit_distance: number;
  requires_confirmation: boolean;
  engine: string;
}

export interface PredictResult {
  accepted: boolean;
  class_id: number;
  hand: string;
  predicted_morse: string;
  morse: string | null;
  confidence: number;
  probabilities: { left_dot: number; right_dash: number };
  threshold: number;
  retry_required: boolean;
}

export interface WindowConfig {
  tmin: number;
  tmax: number;
  duration: number;
  samples: number;
  bounds: number[];
  min_span: number;
  trained_default: number[];
}

export interface WaveformEvent {
  code: number;
  sample: number;
  index: number;
  epoch_index: number | null;
  confidence: number | null;
  label: string | null;
  time_s: number;
}

export interface WaveformData {
  sample_rate: number;
  stride: number;
  duration_s: number;
  total_samples: number;
  traces: number[][];
  events: WaveformEvent[];
}

export interface EpochPage {
  total: number;
  start: number;
  epochs: number[][][];
}

export interface DecodedMorse {
  decoded_text: string;
  decoded_morse: string;
  unknown_sequences: string[];
  correction?: CorrectionPayload | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload.error ?? `HTTP ${response.status}`));
  }
  return payload as T;
}

export function getHealth(): Promise<HealthInfo> {
  return request<HealthInfo>("/api/algorithm/health");
}

export function predictEpoch(epoch: number[][], threshold?: number): Promise<PredictResult> {
  return request<PredictResult>("/api/algorithm/predict", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ epoch, ...(threshold !== undefined ? { threshold } : {}) }),
  });
}

export function setThreshold(threshold: number): Promise<{ confidence_threshold: number }> {
  return request("/api/algorithm/threshold", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threshold }),
  });
}

export function getWindow(): Promise<WindowConfig> {
  return request<WindowConfig>("/api/window");
}

export function setWindow(tmin: number, tmax: number): Promise<WindowConfig> {
  return request<WindowConfig>("/api/window", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tmin, tmax }),
  });
}

export function uploadSource(file: File): Promise<SourceMeta> {
  return request<SourceMeta>("/api/data/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
}

export function listSources(): Promise<{ sources: SourceMeta[] }> {
  return request("/api/data/sources");
}

export function getSource(id: string): Promise<SourceMeta> {
  return request<SourceMeta>(`/api/data/source?id=${encodeURIComponent(id)}`);
}

export function getWaveform(id: string, maxPoints = 6000): Promise<WaveformData> {
  return request<WaveformData>(`/api/data/waveform?id=${encodeURIComponent(id)}&max_points=${maxPoints}`);
}

export function getEpochs(id: string, start: number, count = 64): Promise<EpochPage> {
  return request<EpochPage>(`/api/data/epochs?id=${encodeURIComponent(id)}&start=${start}&count=${count}`);
}

export function trainFallback(sourceId: string): Promise<{ status: unknown; source_id: string }> {
  return request("/api/fallback/train", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_id: sourceId }),
  });
}

export function startSimulation(text: string): Promise<SourceMeta> {
  return request<SourceMeta>("/api/simulation/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export function decodeEvents(events: number[]): Promise<DecodedMorse> {
  return request<DecodedMorse>("/api/morse/decode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
}

// ---------------------------------------------------------------------------
// 实时解码（正式模式设备接入）
// ---------------------------------------------------------------------------

export interface LiveStatus {
  running: boolean;
  source: string | null;
  started_at: string | null;
  event_count: number;
  duration_s: number;
  decoded_text: string;
  unknown_sequences: string[];
  error: string | null;
  config: Record<string, unknown>;
}

export interface LiveEvent {
  index: number;
  code: number;
  label: string | null;
  confidence: number | null;
  time_s: number;
  sample: number;
  source: string;
}

export interface LiveWaveform {
  traces: number[][];
  events: Array<LiveEvent & { index: number }>;
  sample_rate: number;
  stride: number;
  total_samples: number;
}

export interface LslStreamInfo {
  name: string;
  type: string;
  channels: number;
  sfreq: number;
  uid: string;
}

export function liveStart(config: {
  source: "mock" | "lsl";
  text?: string;
  interval?: number;
  lsl_name?: string;
  lsl_type?: string;
}): Promise<LiveStatus> {
  return request<LiveStatus>("/api/live/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export function liveStop(): Promise<LiveStatus> {
  return request<LiveStatus>("/api/live/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export function liveStatus(): Promise<LiveStatus> {
  return request<LiveStatus>("/api/live/status");
}

export function liveEvents(after: number): Promise<{ events: LiveEvent[]; next: number }> {
  return request(`/api/live/events?after=${after}`);
}

export function liveWaveform(maxPoints = 2000): Promise<LiveWaveform> {
  return request<LiveWaveform>(`/api/live/waveform?max_points=${maxPoints}`);
}

export function lslStreams(): Promise<{ streams: LslStreamInfo[] }> {
  return request("/api/live/lsl/streams");
}
