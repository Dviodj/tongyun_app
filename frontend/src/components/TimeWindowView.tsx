/** 时间窗调整：可拖动的解码时间窗（对应算法仓库 0.5–4.0 s epoch）。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Clock, Info, Lightning, PencilSimple, Timer } from "@phosphor-icons/react";
import { setWindow as apiSetWindow } from "../api/client";
import { useAppStore } from "../state/store";
import { Button, Card, Chip } from "./ui";

const DISPLAY_MIN = -1;
const DISPLAY_MAX = 5;
const HANDLE_HIT = 12;

interface Preset {
  label: string;
  tmin: number;
  tmax: number;
  icon: typeof Timer;
}

const PRESETS: Preset[] = [
  { label: "训练默认", tmin: 0.5, tmax: 4.0, icon: Timer },
  { label: "短窗", tmin: 0.5, tmax: 2.5, icon: Lightning },
  { label: "长窗", tmin: 0.0, tmax: 4.5, icon: Clock },
  { label: "快速响应", tmin: 0.8, tmax: 2.8, icon: PencilSimple },
];

function buildSyntheticTrace(points: number, seed = 7): number[][] {
  const traces: number[][] = [[], [], []];
  let s1 = seed;
  let s2 = seed * 3;
  let s3 = seed * 5;
  const rand = () => {
    s1 = (s1 * 9301 + 49297) % 233280;
    s2 = (s2 * 9301 + 49297) % 233280;
    s3 = (s3 * 9301 + 49297) % 233280;
    return [(s1 / 233280 - 0.5) * 2, (s2 / 233280 - 0.5) * 2, (s3 / 233280 - 0.5) * 2];
  };
  for (let i = 0; i < points; i += 1) {
    const t = DISPLAY_MIN + ((DISPLAY_MAX - DISPLAY_MIN) * i) / points;
    const [n1, n2, n3] = rand();
    const alpha = Math.sin(2 * Math.PI * 10 * t) * 0.45 + Math.sin(2 * Math.PI * 21 * t) * 0.25;
    traces[0].push(alpha * (1 - 0.35 * Math.exp(-((t - 1.2) ** 2) / 1.4)) + n1 * 0.3);
    traces[1].push(Math.sin(2 * Math.PI * 9 * t) * 0.3 + n2 * 0.42);
    traces[2].push(alpha * (1 - 0.3 * Math.exp(-((t - 1.0) ** 2) / 1.6)) + n3 * 0.3);
  }
  return traces;
}

export function TimeWindowView() {
  const windowConfig = useAppStore((state) => state.window);
  const setWindowConfig = useAppStore((state) => state.setWindow);
  const source = useAppStore((state) => state.source);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [draft, setDraft] = useState({ tmin: windowConfig.tmin, tmax: windowConfig.tmax });
  const [dragMode, setDragMode] = useState<"left" | "right" | "move" | null>(null);
  const dragStartRef = useRef<{ x: number; tmin: number; tmax: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    setDraft({ tmin: windowConfig.tmin, tmax: windowConfig.tmax });
  }, [windowConfig]);

  const synthetic = useMemo(() => buildSyntheticTrace(700), []);
  const previewEpoch = source?.preview_epoch;

  const minSpan = windowConfig.min_span ?? 0.25;
  const [boundMin, boundMax] = windowConfig.bounds ?? [DISPLAY_MIN, 8];

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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
    const timeToX = (t: number) => ((t - DISPLAY_MIN) / (DISPLAY_MAX - DISPLAY_MIN)) * w;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = theme === "dark" ? "#1c1c1e" : "#ffffff";
    ctx.fillRect(0, 0, w, h);

    const grid = theme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)";
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let t = Math.ceil(DISPLAY_MIN); t <= DISPLAY_MAX; t += 1) {
      const x = timeToX(t);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = theme === "dark" ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.5)";
      ctx.font = "11px -apple-system, 'SF Pro Text', 'Segoe UI Variable', sans-serif";
      ctx.fillText(`${t}s`, x + 4, h - 6);
    }
    ctx.strokeStyle = theme === "dark" ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.moveTo(timeToX(0), 0);
    ctx.lineTo(timeToX(0), h);
    ctx.stroke();
    ctx.fillStyle = theme === "dark" ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.6)";
    ctx.fillText("事件 0s", timeToX(0) + 4, 16);

    // 训练默认窗口底色
    ctx.fillStyle = "rgba(48, 209, 88, 0.08)";
    ctx.fillRect(timeToX(0.5), 0, timeToX(4.0) - timeToX(0.5), h);

    // 波形
    const laneColors = ["rgba(255,69,58,0.75)", "rgba(48,209,88,0.75)", "rgba(10,132,255,0.75)"];
    for (let lane = 0; lane < 3; lane += 1) {
      ctx.strokeStyle = laneColors[lane];
      ctx.lineWidth = 1.05;
      ctx.beginPath();
      const trace = synthetic[lane];
      for (let i = 0; i < trace.length; i += 1) {
        const t = DISPLAY_MIN + ((DISPLAY_MAX - DISPLAY_MIN) * i) / trace.length;
        const x = timeToX(t);
        const y = h / 2 + trace[i] * (h * 0.36);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    if (previewEpoch?.[0]) {
      // 源文件 preview epoch（0.5–4.0 s）
      const laneColorsStrong = ["#ff453a", "#30d158", "#0a84ff"];
      for (let lane = 0; lane < 3; lane += 1) {
        const trace = previewEpoch[lane] ?? [];
        if (!trace.length) continue;
        let maxAbs = 1e-6;
        for (let i = 0; i < trace.length; i += 2) maxAbs = Math.max(maxAbs, Math.abs(trace[i]));
        ctx.strokeStyle = laneColorsStrong[lane];
        ctx.lineWidth = 1.7;
        ctx.beginPath();
        for (let i = 0; i < trace.length; i += 1) {
          const t = 0.5 + (3.5 * i) / trace.length;
          const x = timeToX(t);
          const y = h / 2 + (trace[i] / maxAbs) * (h * 0.3);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // 时间窗
    const x1 = timeToX(draft.tmin);
    const x2 = timeToX(draft.tmax);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0a84ff";
    ctx.fillStyle = "rgba(10, 132, 255, 0.13)";
    ctx.fillRect(x1, 8, x2 - x1, h - 16);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, 8, x2 - x1, h - 16);
    // 手柄
    for (const [x, mode] of [[x1, "left"], [x2, "right"]] as const) {
      ctx.fillStyle = accent;
      ctx.fillRect(x - 4, 8, 8, h - 16);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px -apple-system, sans-serif";
      ctx.fillText(mode === "left" ? "◀" : "▶", x - 2.5, h / 2 + 3.5);
    }
    // 时长标签
    const duration = draft.tmax - draft.tmin;
    ctx.fillStyle = theme === "dark" ? "#ffffff" : "#1c1c1e";
    ctx.font = "600 12px -apple-system, 'SF Pro Text', sans-serif";
    const label = `${duration.toFixed(2)} s · ${Math.round(duration * 100) + 1} 采样`;
    const labelWidth = ctx.measureText(label).width + 14;
    const labelX = Math.min(Math.max((x1 + x2) / 2 - labelWidth / 2, 6), w - labelWidth - 6);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillRect(labelX, h / 2 - 11, labelWidth, 22);
    ctx.fillStyle = "#1c1c1e";
    ctx.fillText(label, labelX + 7, h / 2 + 4);
  };

  useEffect(() => {
    draw();
  });

  useEffect(() => {
    const observer = new ResizeObserver(() => draw());
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  });

  const pointerToTime = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return DISPLAY_MIN;
    const rect = canvas.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const t = DISPLAY_MIN + ratio * (DISPLAY_MAX - DISPLAY_MIN);
    return Math.min(Math.max(t, boundMin), boundMax);
  };

  const hitZone = (clientX: number): "left" | "right" | "move" | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x1 = ((draft.tmin - DISPLAY_MIN) / (DISPLAY_MAX - DISPLAY_MIN)) * rect.width;
    const x2 = ((draft.tmax - DISPLAY_MIN) / (DISPLAY_MAX - DISPLAY_MIN)) * rect.width;
    const local = clientX - rect.left;
    if (Math.abs(local - x1) <= HANDLE_HIT) return "left";
    if (Math.abs(local - x2) <= HANDLE_HIT) return "right";
    if (local > x1 && local < x2) return "move";
    return null;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const zone = hitZone(event.clientX);
    if (!zone) return;
    setDragMode(zone);
    dragStartRef.current = { x: event.clientX, tmin: draft.tmin, tmax: draft.tmax };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSaved(false);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragMode || !dragStartRef.current) return;
    const start = dragStartRef.current;
    const t = pointerToTime(event.clientX);
    const t0 = pointerToTime(start.x);
    const delta = t - t0;
    if (dragMode === "left") {
      setDraft({
        tmin: Math.min(Math.max(start.tmin + delta, boundMin), draft.tmax - minSpan),
        tmax: draft.tmax,
      });
    } else if (dragMode === "right") {
      setDraft({
        tmin: draft.tmin,
        tmax: Math.max(Math.min(start.tmax + delta, boundMax), draft.tmin + minSpan),
      });
    } else {
      const span = draft.tmax - draft.tmin;
      const tmin = Math.min(Math.max(start.tmin + delta, boundMin), boundMax - span);
      setDraft({ tmin, tmax: tmin + span });
    }
  };

  const onPointerUp = () => {
    setDragMode(null);
    dragStartRef.current = null;
  };

  const applyWindow = async () => {
    setApplying(true);
    setError(null);
    try {
      const updated = await apiSetWindow(draft.tmin, draft.tmax);
      setWindowConfig(updated);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const applyPreset = (preset: Preset) => {
    setDraft({ tmin: preset.tmin, tmax: preset.tmax });
    setSaved(false);
  };

  const deviatesFromTrained =
    Math.abs(draft.tmin - 0.5) > 0.05 || Math.abs(draft.tmax - 4.0) > 0.05;

  return (
    <div className="window-view">
      <Card className="window-card">
        <div className="window-presets-row">
          {PRESETS.map((preset) => {
            const Icon = preset.icon;
            return (
              <Chip
                key={preset.label}
                onClick={() => applyPreset(preset)}
                className="chip-preset"
                selected={draft.tmin === preset.tmin && draft.tmax === preset.tmax}
              >
                <Icon size={13} weight="duotone" /> {preset.label}
              </Chip>
            );
          })}
        </div>

        <div className="window-canvas-wrap">
          <canvas
            ref={canvasRef}
            className="window-canvas"
            aria-label="可拖动的解码时间窗"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>

        <div className="window-readout">
          <label className="window-field">
            <span>窗口起点 tmin</span>
            <input
              type="number"
              step={0.05}
              min={boundMin}
              max={draft.tmax - minSpan}
              value={Number(draft.tmin.toFixed(2))}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) {
                  setDraft({ tmin: Math.min(Math.max(value, boundMin), draft.tmax - minSpan), tmax: draft.tmax });
                  setSaved(false);
                }
              }}
              aria-label="窗口起点（秒）"
            />
            <em>s</em>
          </label>
          <label className="window-field">
            <span>窗口终点 tmax</span>
            <input
              type="number"
              step={0.05}
              min={draft.tmin + minSpan}
              max={boundMax}
              value={Number(draft.tmax.toFixed(2))}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) {
                  setDraft({ tmin: draft.tmin, tmax: Math.max(Math.min(value, boundMax), draft.tmin + minSpan) });
                  setSaved(false);
                }
              }}
              aria-label="窗口终点（秒）"
            />
            <em>s</em>
          </label>
          <div className="window-stat">
            <span>窗长</span>
            <b>{(draft.tmax - draft.tmin).toFixed(2)} s</b>
          </div>
          <div className="window-stat">
            <span>采样点</span>
            <b>{Math.round((draft.tmax - draft.tmin) * 100) + 1}</b>
          </div>
          <Button variant="primary" onClick={() => void applyWindow()} disabled={applying}>
            {applying ? "应用中…" : saved ? "已应用 ✓" : "应用窗口"}
          </Button>
        </div>

        {deviatesFromTrained && (
          <div className="window-hint">
            <Info size={15} weight="fill" />
            与模型训练窗口（0.5–4.0 s）不同：解码精度可能下降，仅建议用于实验对比。
          </div>
        )}
        {error && <div className="window-hint is-error">{error}</div>}
      </Card>

      <Card className="window-explain">
        <ul>
          <li>
            <b>训练默认 0.5–4.0 s</b>：避开前 0.5 s 运动伪迹，覆盖运动想象全程；100 Hz 下为 351 个采样点。
          </li>
          <li>
            <b>窗口变化</b>：后端按新窗口切分 GDF/EDF/FIF，并在送入模型前重采样回 351 点，保持与训练分布一致。
          </li>
          <li>
            <b>已缓存数据</b>：已解析的源文件保留原窗口；修改后重新上传或切换源文件即可按新窗口解析。
          </li>
          <li>
            <b>实时设备</b>：窗口决定每次滑动解码使用多长一段脑电缓冲，短窗响应更快、长窗更稳健。
          </li>
        </ul>
      </Card>
    </div>
  );
}
