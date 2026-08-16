/** 底部状态栏：模式 / 算法 / 时间窗 / 门控 / 事件数 / 源文件 / 实时状态。 */
import { useAppStore } from "../state/store";

export function StatusBar() {
  const mode = useAppStore((state) => state.mode);
  const health = useAppStore((state) => state.algorithmHealth);
  const windowConfig = useAppStore((state) => state.window);
  const threshold = useAppStore((state) => state.threshold);
  const morseHistory = useAppStore((state) => state.morseHistory);
  const source = useAppStore((state) => state.source);
  const live = useAppStore((state) => state.live);

  return (
    <footer className="statusbar" aria-label="系统状态栏">
      <span className="statusbar-item">
        模式 <b>{mode === "simulation" ? "模拟" : "正式"}</b>
      </span>
      <span className="statusbar-item">
        算法{" "}
        <b className={health.modelLoaded ? "ok" : health.fallbackTrained ? "warn" : ""}>
          {health.loading ? "…" : health.modelLoaded ? "FBC-MIFormer" : health.fallbackTrained ? "CSP+LDA" : "模拟"}
        </b>
      </span>
      <span className="statusbar-item">
        时间窗 <b>{windowConfig.tmin.toFixed(2)}–{windowConfig.tmax.toFixed(2)} s</b>
      </span>
      <span className="statusbar-item">
        门控 <b>{Math.round(threshold * 100)}%</b>
      </span>
      <span className="statusbar-item">
        事件 <b>{morseHistory.length}</b>
      </span>
      {source && (
        <span className="statusbar-item">
          源 <b>{source.name}</b>
        </span>
      )}
      {live.running && (
        <span className="statusbar-item">
          实时 <b className="live">{live.source === "lsl" ? "LSL" : "模拟设备"} · {live.decodedText || "…"}</b>
        </span>
      )}
      <span className="statusbar-spacer" />
      <span className="statusbar-item">100 Hz · C3/Cz/C4</span>
    </footer>
  );
}
