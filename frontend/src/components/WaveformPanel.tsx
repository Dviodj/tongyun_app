/** 源文件波形面板：三通道 Canvas 波形 + 播放引擎 + 文件加载/拖拽 + 实时解码显示。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileArrowUp,
  Lightning,
  Pause,
  Play,
  Sparkle,
  Stop,
  Waveform,
} from "@phosphor-icons/react";
import {
  getWaveform,
  getEpochs,
  listSources,
  liveWaveform,
  predictEpoch,
  startSimulation,
  trainFallback,
  uploadSource,
  type LiveWaveform,
  type SourceMeta,
  type WaveformData,
} from "../api/client";
import {
  EVENT_LETTER_BOUNDARY,
  EVENT_WORD_BOUNDARY,
} from "../lib/morse";
import { useAppStore } from "../state/store";
import { BOOT_PARAMS } from "../App";
import { Button, Chip, Segmented } from "./ui";

const CHANNEL_COLORS = ["#ff453a", "#30d158", "#0a84ff"];
const CHANNEL_NAMES = ["C3", "Cz", "C4"];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 || value >= 10 ? 0 : 1)} ${units[index]}`;
}

export function WaveformPanel() {
  const source = useAppStore((state) => state.source);
  const setSource = useAppStore((state) => state.setSource);
  const status = useAppStore((state) => state.status);
  const setStatus = useAppStore((state) => state.setStatus);
  const handleEvent = useAppStore((state) => state.handleEvent);
  const handlePredictResult = useAppStore((state) => state.handlePredictResult);
  const clearAll = useAppStore((state) => state.clearAll);
  const threshold = useAppStore((state) => state.threshold);
  const setHealth = useAppStore((state) => state.setHealth);
  const algorithmHealth = useAppStore((state) => state.algorithmHealth);
  const mode = useAppStore((state) => state.mode);
  const liveRunning = useAppStore((state) => state.live.running);
  const windowConfig = useAppStore((state) => state.window);
  const formal = mode === "formal";

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clearAllRef = useRef<() => void>(() => {});
  clearAllRef.current = clearAll;
  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  const [liveWave, setLiveWave] = useState<LiveWaveform | null>(null);
  const [speed, setSpeed] = useState<"0.5" | "1" | "2">("1");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [simText, setSimText] = useState("HELLO WORLD");
  const [training, setTraining] = useState(false);
  const [historySources, setHistorySources] = useState<SourceMeta[]>([]);

  const playheadRef = useRef(0);
  const nextEventRef = useRef(0);
  const nextBoundaryRef = useRef(-1);
  const lastTickRef = useRef<number | null>(null);
  const pendingRef = useRef(new Set<number>());
  const epochCacheRef = useRef(new Map<number, number[][]>());
  const frameRef = useRef<number | null>(null);
  const autoPlayRef = useRef(false);

  const events = useMemo(() => waveform?.events ?? [], [waveform]);

  const loadWaveform = useCallback(async (sourceId: string) => {
    try {
      const data = await getWaveform(sourceId);
      setWaveform(data);
      playheadRef.current = 0;
      nextEventRef.current = 0;
      nextBoundaryRef.current = -1;
      pendingRef.current.clear();
      epochCacheRef.current.clear();
      if (autoPlayRef.current) {
        autoPlayRef.current = false;
        clearAllRef.current();
        setStatus("playing");
      }
    } catch (error) {
      setNotice(`波形加载失败：${(error as Error).message}`);
    }
  }, []);

  useEffect(() => {
    if (source?.id) void loadWaveform(source.id);
    else {
      setWaveform(null);
      playheadRef.current = 0;
    }
  }, [source?.id, loadWaveform]);

  // 实时解码：轮询设备波形缓冲
  useEffect(() => {
    if (!liveRunning) {
      setLiveWave(null);
      return undefined;
    }
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        const data = await liveWaveform(2000);
        if (active) setLiveWave(data);
      } catch {
        /* 忽略瞬时错误 */
      }
      if (active) timer = window.setTimeout(poll, 500);
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [liveRunning]);

  const fetchEpoch = useCallback(async (epochIndex: number): Promise<number[][] | null> => {
    if (!source?.id) return null;
    const cached = epochCacheRef.current.get(epochIndex);
    if (cached) return cached;
    try {
      const page = await getEpochs(source.id, epochIndex, 1);
      const epoch = page.epochs[0];
      if (epoch) {
        epochCacheRef.current.set(epochIndex, epoch);
        return epoch;
      }
      return null;
    } catch (error) {
      setNotice(`Epoch 读取失败：${(error as Error).message}`);
      return null;
    }
  }, [source?.id]);

  const isStreamSource = source?.source_mode === "event_stream" || source?.source_mode === "simulation";

  const dispatchEvent = useCallback(
    (event: WaveformData["events"][number]) => {
      if (isStreamSource) {
        const eventSource = source?.source_mode === "simulation" ? "simulation" : "file";
        handleEvent(event.code as 1 | 2 | 3 | 4, {
          confidence: event.confidence ?? null,
          source: eventSource,
        });
        return;
      }
      if (event.epoch_index == null || pendingRef.current.has(event.epoch_index)) return;
      const epochIndex = event.epoch_index;
      pendingRef.current.add(epochIndex);
      void fetchEpoch(epochIndex).then(async (epoch) => {
        pendingRef.current.delete(epochIndex);
        if (!epoch) return;
        try {
          const result = await predictEpoch(epoch, threshold);
          handlePredictResult(result, "algorithm");
        } catch (error) {
          setNotice(`推理失败：${(error as Error).message}`);
        }
        // 每个 epoch 之后自动作为字母边界（GDF 无空格标记）
        nextBoundaryRef.current = playheadRef.current + 90;
      });
    },
    [isStreamSource, source?.source_mode, handleEvent, fetchEpoch, handlePredictResult, threshold],
  );

  // 播放循环
  useEffect(() => {
    if (status !== "playing" || !waveform) return undefined;
    const frame = (time: number) => {
      if (lastTickRef.current == null) lastTickRef.current = time;
      const dt = (time - lastTickRef.current) / 1000;
      lastTickRef.current = time;
      const rate = 100 * Number(speed);
      playheadRef.current = Math.min(waveform.total_samples, playheadRef.current + dt * rate);

      const sorted = events;
      while (nextEventRef.current < sorted.length && sorted[nextEventRef.current].sample <= playheadRef.current) {
        dispatchEvent(sorted[nextEventRef.current]);
        nextEventRef.current += 1;
      }
      if (
        nextBoundaryRef.current > 0 &&
        playheadRef.current >= nextBoundaryRef.current
      ) {
        nextBoundaryRef.current = -1;
        handleEvent(EVENT_LETTER_BOUNDARY, {});
      }

      drawCanvas();
      if (playheadRef.current >= waveform.total_samples) {
        setStatus("idle");
        handleEvent(EVENT_WORD_BOUNDARY, {});
        return;
      }
      frameRef.current = requestAnimationFrame(frame);
    };
    frameRef.current = requestAnimationFrame(frame);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastTickRef.current = null;
    };
  }, [status, waveform, speed, events, dispatchEvent, handleEvent, setStatus]);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveform) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const bg = theme === "dark" ? "#1e232b" : "#fbfcfd";
    const grid = theme === "dark" ? "rgba(255,255,255,0.06)" : "#e3e7ec";
    const laneH = h / 3;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const laneCount = Math.min(waveform.traces.length, 3);
    const displayLen = waveform.traces[0]?.length ?? 0;
    if (displayLen === 0) return;

    // 全通道统一幅度
    let maxAbs = 0;
    for (const trace of waveform.traces) {
      for (let i = 0; i < trace.length; i += 4) {
        const value = Math.abs(trace[i]);
        if (value > maxAbs) maxAbs = value;
      }
    }
    maxAbs = maxAbs || 1e-6;
    const scale = (laneH * 0.42) / maxAbs;

    // 网格
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += w / 10) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let lane = 0; lane <= 3; lane += 1) {
      ctx.beginPath();
      ctx.moveTo(0, lane * laneH);
      ctx.lineTo(w, lane * laneH);
      ctx.stroke();
    }

    // 通道标签
    ctx.font = "600 11px 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
    for (let lane = 0; lane < laneCount; lane += 1) {
      ctx.fillStyle = CHANNEL_COLORS[lane];
      ctx.fillText(CHANNEL_NAMES[lane], 10, lane * laneH + 18);
      ctx.fillStyle = theme === "dark" ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)";
      ctx.fillText("μV", 40, lane * laneH + 18);
    }

    // 波形
    for (let lane = 0; lane < laneCount; lane += 1) {
      const trace = waveform.traces[lane];
      ctx.strokeStyle = CHANNEL_COLORS[lane];
      ctx.lineWidth = 1.1;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      for (let i = 0; i < trace.length; i += 1) {
        const x = (i / displayLen) * w;
        const y = lane * laneH + laneH / 2 - trace[i] * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 事件标记
    for (const event of events) {
      const x = (event.index / displayLen) * w;
      const y = 14;
      if (event.label === "dot") {
        ctx.fillStyle = "#0a84ff";
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (event.label === "dash") {
        ctx.strokeStyle = "#ff9f0a";
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(x - 4, y);
        ctx.lineTo(x + 4, y);
        ctx.stroke();
      } else if (event.label === "boundary") {
        ctx.strokeStyle = theme === "dark" ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 6);
        ctx.lineTo(x, 20);
        ctx.stroke();
      } else if (event.label === "space") {
        ctx.strokeStyle = theme === "dark" ? "#ffffff" : "#3a3a3c";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, 6);
        ctx.lineTo(x, 20);
        ctx.stroke();
      }
    }

    // 播放头
    const playheadX = (playheadRef.current / waveform.stride / displayLen) * w;
    ctx.strokeStyle = "#ff375f";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, h);
    ctx.stroke();
    ctx.fillStyle = "#ff375f";
    ctx.beginPath();
    ctx.arc(playheadX, 24, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }, [waveform, events]);

  // 实时解码波形：滚动缓冲 + 解码窗口着色 + 事件标记 + 最右播放头
  const drawLiveCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !liveWave) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const bg = theme === "dark" ? "#1e232b" : "#fbfcfd";
    const grid = theme === "dark" ? "rgba(255,255,255,0.06)" : "#e3e7ec";
    const laneH = h / 3;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const displayLen = liveWave.traces[0]?.length ?? 0;
    if (displayLen === 0) {
      ctx.fillStyle = theme === "dark" ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.4)";
      ctx.font = "13px 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("等待设备数据…", w / 2, h / 2);
      ctx.textAlign = "start";
      return;
    }

    let maxAbs = 0;
    for (const trace of liveWave.traces) {
      for (let i = 0; i < trace.length; i += 4) {
        const value = Math.abs(trace[i]);
        if (value > maxAbs) maxAbs = value;
      }
    }
    maxAbs = maxAbs || 1e-6;
    const scale = (laneH * 0.42) / maxAbs;

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += w / 10) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let lane = 0; lane <= 3; lane += 1) {
      ctx.beginPath();
      ctx.moveTo(0, lane * laneH);
      ctx.lineTo(w, lane * laneH);
      ctx.stroke();
    }

    ctx.font = "600 11px 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
    for (let lane = 0; lane < 3; lane += 1) {
      ctx.fillStyle = CHANNEL_COLORS[lane];
      ctx.fillText(CHANNEL_NAMES[lane], 10, lane * laneH + 18);
    }
    ctx.fillStyle = theme === "dark" ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)";
    ctx.fillText("实时 · 100 Hz", w - 92, 18);

    // 当前解码窗口着色（缓冲最右侧，长度 = 时间窗）
    const windowSamples = Math.round((windowConfig.tmax - windowConfig.tmin) * 100);
    const windowStartX = Math.max(0, w - (windowSamples / displayLen) * w * liveWave.stride);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0a84ff";
    ctx.fillStyle = "rgba(10, 132, 255, 0.1)";
    ctx.fillRect(windowStartX, 0, w - windowStartX, h);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(windowStartX, 0);
    ctx.lineTo(windowStartX, h);
    ctx.stroke();

    for (let lane = 0; lane < 3; lane += 1) {
      const trace = liveWave.traces[lane] ?? [];
      if (!trace.length) continue;
      ctx.strokeStyle = CHANNEL_COLORS[lane];
      ctx.lineWidth = 1.1;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      for (let i = 0; i < trace.length; i += 1) {
        const x = (i / displayLen) * w;
        const y = lane * laneH + laneH / 2 - trace[i] * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const event of liveWave.events ?? []) {
      const x = (event.index / displayLen) * w;
      const y = 14;
      if (event.label === "dot") {
        ctx.fillStyle = "#0a84ff";
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (event.label === "dash") {
        ctx.strokeStyle = "#ff9f0a";
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(x - 4, y);
        ctx.lineTo(x + 4, y);
        ctx.stroke();
      } else if (event.label === "boundary") {
        ctx.strokeStyle = theme === "dark" ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 6);
        ctx.lineTo(x, 20);
        ctx.stroke();
      } else if (event.label === "space") {
        ctx.strokeStyle = theme === "dark" ? "#ffffff" : "#3a3a3c";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, 6);
        ctx.lineTo(x, 20);
        ctx.stroke();
      } else if (event.label === "rejected") {
        ctx.strokeStyle = "#ff453a";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x + 4, y + 4);
        ctx.moveTo(x + 4, y - 4);
        ctx.lineTo(x - 4, y + 4);
        ctx.stroke();
      }
    }

    // 实时播放头（最右）
    ctx.strokeStyle = "#ff375f";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(w - 1, 0);
    ctx.lineTo(w - 1, h);
    ctx.stroke();
    ctx.fillStyle = "#ff375f";
    ctx.beginPath();
    ctx.arc(w - 1, 24, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }, [liveWave, windowConfig]);

  const drawActive = useCallback(() => {
    if (liveRunning && liveWave) drawLiveCanvas();
    else drawCanvas();
  }, [liveRunning, liveWave, drawLiveCanvas, drawCanvas]);

  useEffect(() => {
    drawActive();
  }, [waveform, events, drawActive, status, liveWave, liveRunning]);

  // 窗口缩放重绘
  useEffect(() => {
    const observer = new ResizeObserver(() => drawActive());
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [drawActive]);

  const togglePlay = () => {
    if (!waveform || liveRunning) return;
    if (status === "playing") {
      setStatus("paused");
      return;
    }
    if (playheadRef.current >= waveform.total_samples) {
      // 播完重播：从头开始，清空会话
      playheadRef.current = 0;
      nextEventRef.current = 0;
      nextBoundaryRef.current = -1;
      pendingRef.current.clear();
      clearAll();
    } else if (status === "idle" && playheadRef.current === 0) {
      // 全新开始：避免残留的点划污染第一个字母组
      clearAll();
    }
    setStatus("playing");
  };

  const resetPlayback = () => {
    playheadRef.current = 0;
    nextEventRef.current = 0;
    nextBoundaryRef.current = -1;
    pendingRef.current.clear();
    clearAll();
    setStatus("idle");
    drawCanvas();
  };

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setUploading(true);
      setNotice(`正在上传并解析：${file.name}`);
      try {
        const result = await uploadSource(file);
        setSource(result);
        if (result.state === "ready") {
          setNotice(
            result.source_mode === "event_stream"
              ? `事件流已解码：${result.decoded_text ?? ""}（${result.event_count ?? 0} 个事件）`
              : `已解析 ${result.epoch_count} 个 Epoch${result.label_counts ? ` · 左手 ${result.label_counts.left} / 右手 ${result.label_counts.right}` : ""}`,
          );
        } else {
          setNotice(`文件已保存：${result.parse_error ?? "待解析"}`);
        }
      } catch (error) {
        setNotice(`加载失败：${(error as Error).message}`);
      } finally {
        setUploading(false);
      }
    },
    [setSource],
  );

  const handleSimulation = async () => {
    setNotice("正在生成模拟脑电…");
    try {
      const result = await startSimulation(simText.trim() || "HELLO WORLD");
      setSource(result);
      setNotice(`模拟源已就绪：${result.decoded_text ?? ""}（${result.event_count ?? 0} 个事件）`);
    } catch (error) {
      setNotice(`模拟失败：${(error as Error).message}`);
    }
  };

  const handleTrainFallback = async () => {
    if (!source?.id) return;
    setTraining(true);
    setNotice("正在训练 CSP+LDA 回退分类器…");
    try {
      const result = await trainFallback(source.id);
      const statusInfo = result.status as { holdout_accuracy?: number; train_samples?: number };
      setHealth({
        loading: false,
        modelLoaded: algorithmHealth.modelLoaded,
        fallbackTrained: true,
        error: algorithmHealth.error,
      });
      setNotice(
        `回退分类器训练完成：${statusInfo.train_samples ?? 0} 样本` +
          (statusInfo.holdout_accuracy != null
            ? ` · 4 折交叉验证准确率 ${(statusInfo.holdout_accuracy * 100).toFixed(1)}%`
            : ""),
      );
    } catch (error) {
      setNotice(`训练失败：${(error as Error).message}`);
    } finally {
      setTraining(false);
    }
  };

  // 历史源文件
  useEffect(() => {
    let active = true;
    void listSources()
      .then((payload) => active && setHistorySources(payload.sources))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [source?.id, uploading]);

  // 一键演示：?demo=HELLO WORLD&speed=2（参数可跟在 #hash 后）
  useEffect(() => {
    const demo = BOOT_PARAMS.get("demo");
    const demoSpeed = BOOT_PARAMS.get("speed");
    if (demo) {
      const text = demo === "1" ? "HELLO WORLD" : demo;
      if (demoSpeed === "0.5" || demoSpeed === "1" || demoSpeed === "2") {
        setSpeed(demoSpeed);
      }
      autoPlayRef.current = true;
      void startSimulation(text).then((result) => {
        setSource(result);
        setNotice(`演示模式：正在回放「${result.decoded_text ?? text}」`);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickHistorySource = async (sourceId: string) => {
    const picked = historySources.find((item) => item.id === sourceId);
    if (!picked) return;
    setSource(picked);
    setNotice(`已切换到：${picked.name}`);
  };

  return (
    <div className="waveform-card widget-segment">
      <div
        className={`source-dropzone ${dragging ? "is-dragging" : ""} ${uploading ? "is-uploading" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void handleFile(event.dataTransfer.files?.[0]);
        }}
      >
        <label className="source-dropzone-inner">
          <input
            type="file"
            aria-label="选择脑电源文件"
            accept=".gdf,.edf,.fif,.json,.npy,application/json,application/octet-stream"
            onChange={(event) => {
              void handleFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <span className="source-icon">
            <FileArrowUp size={18} />
          </span>
          <span className="source-copy">
            <strong>{source ? source.name : "加载脑电源文件"}</strong>
            <small>
              {source
                ? `${formatBytes(source.size_bytes)} · ${source.source_mode === "event_stream" ? "事件流" : source.source_mode === "simulation" ? "模拟源" : `${source.epoch_count} Epoch`}`
                : "点击选择或拖拽 · GDF / EDF / FIF / JSON / NPY"}
            </small>
          </span>
          {source ? <Chip className="chip-source-ready">{source.state === "ready" ? "已就绪" : "已保存"}</Chip> : null}
        </label>
      </div>

      <div className="waveform-toolbar">
        <div className="waveform-controls">
          <Segmented
            ariaLabel="播放速度"
            options={[
              { value: "0.5", label: "0.5×" },
              { value: "1", label: "1×" },
              { value: "2", label: "2×" },
            ]}
            value={speed}
            onChange={setSpeed}
          />
          <Button
            variant="primary"
            onClick={togglePlay}
            disabled={!waveform || liveRunning}
            title={liveRunning ? "实时解码中" : "播放 / 暂停"}
          >
            {status === "playing" ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}
            {status === "playing" ? "暂停" : "播放"}
          </Button>
          <Button variant="quiet" onClick={resetPlayback} disabled={liveRunning} title="回到开头">
            <Stop size={15} weight="fill" /> 重置
          </Button>
        </div>
        <div className="toolbar-spacer" />
        {!formal && (
          <div className="sim-row">
            <span className="sim-label">
              <Lightning size={14} weight="duotone" /> 模拟：
            </span>
            <input
              className="sim-input"
              value={simText}
              onChange={(event) => setSimText(event.target.value)}
              aria-label="模拟文本"
              placeholder="HELLO WORLD"
            />
            <Button variant="quiet" onClick={() => void handleSimulation()}>
              <Sparkle size={14} weight="fill" /> 生成模拟脑电
            </Button>
          </div>
        )}
        {source?.labels?.length ? (
          <Button variant="quiet" onClick={() => void handleTrainFallback()} disabled={training}>
            <Lightning size={14} weight="duotone" />
            {training ? "训练中…" : "训练 CSP+LDA 回退"}
          </Button>
        ) : null}
        {historySources.length > 1 && (
          <select
            className="history-select"
            value={source?.id ?? ""}
            onChange={(event) => void pickHistorySource(event.target.value)}
            aria-label="历史源文件"
          >
            <option value="" disabled>
              历史源文件…
            </option>
            {historySources.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}（{item.source_mode === "event_stream" ? "事件流" : item.source_mode === "simulation" ? "模拟" : `${item.epoch_count} Epoch`}）
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="waveform-canvas-wrap">
        <canvas ref={canvasRef} className="waveform-canvas" aria-label="三通道脑电波形" />
        {!waveform && !liveWave && (
          <div className="waveform-placeholder">
            <Waveform size={26} weight="duotone" />
            <span>{formal ? "连接设备后显示实时波形，或加载源文件" : "加载源文件或生成模拟脑电后显示波形"}</span>
          </div>
        )}
      </div>

      {notice && (
        <div className="waveform-notice" role="status">
          <span className="notice-dot" />
          {notice}
        </div>
      )}
    </div>
  );
}
