/** 顶部应用栏：项目标识 + 模式切换 + 算法/实时状态。 */
import { ArrowsLeftRight, WifiHigh, WifiSlash } from "@phosphor-icons/react";
import { useAppStore } from "../state/store";

export function HeaderBar() {
  const health = useAppStore((state) => state.algorithmHealth);
  const status = useAppStore((state) => state.status);
  const mode = useAppStore((state) => state.mode);
  const toggleMode = useAppStore((state) => state.toggleMode);
  const live = useAppStore((state) => state.live);

  const algorithmLabel = health.loading
    ? "连接算法…"
    : health.modelLoaded
      ? "Hybrid FBC 已就绪"
      : health.fallbackTrained
        ? "CSP+LDA 回退"
        : "未载入权重";

  return (
    <header className="app-header">
      <div className="header-brand">
        <span>通韵 TongYun</span>
        <span className="header-brand-sub">脑电莫尔斯识别</span>
        <span className="header-brand-version">v1.1.0</span>
      </div>
      <div className="header-status">
        <button
          type="button"
          className={`mode-pill ${mode === "formal" ? "is-formal" : "is-simulation"}`}
          onClick={toggleMode}
          title={mode === "simulation" ? "点击切换到正式模式（文件解码 / 实时设备接入）" : "点击切换到模拟模式（演示体验）"}
          aria-pressed={mode === "formal"}
        >
          <ArrowsLeftRight size={13} weight="bold" />
          {mode === "simulation" ? "模拟模式" : "正式模式"}
          <span className="mode-pill-hint">{mode === "simulation" ? "点击切换" : ""}</span>
        </button>
        <span
          className={`status-pill ${health.modelLoaded ? "is-ready" : health.fallbackTrained ? "is-fallback" : "is-sim"}`}
          title={health.error ?? algorithmLabel}
        >
          {algorithmLabel}
        </span>
        {live.running && (
          <span className="status-pill is-live">
            <WifiHigh size={13} weight="bold" /> 实时解码中
          </span>
        )}
        {!live.running && status === "playing" && (
          <span className="status-pill is-live">▶ 播放中</span>
        )}
        {status === "paused" && (
          <span className="status-pill is-live">
            <WifiSlash size={13} weight="bold" /> 已暂停
          </span>
        )}
      </div>
    </header>
  );
}
