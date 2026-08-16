/** macOS 风格标题栏：红黄绿交通灯 + 居中标题 + 右侧可点击的模式切换。 */
import { ArrowsLeftRight, WifiHigh, WifiSlash } from "@phosphor-icons/react";
import { useAppStore } from "../state/store";

export function TitleBar() {
  const health = useAppStore((state) => state.algorithmHealth);
  const status = useAppStore((state) => state.status);
  const mode = useAppStore((state) => state.mode);
  const toggleMode = useAppStore((state) => state.toggleMode);
  const live = useAppStore((state) => state.live);
  const desktop = window.tongyunDesktop;
  const controls = desktop?.controls;

  const handle = (action: "close" | "minimize" | "toggleMaximize") => {
    if (!controls) return;
    if (action === "close") controls.close();
    else if (action === "minimize") controls.minimize();
    else controls.toggleMaximize();
  };

  const lightProps = (action: "close" | "minimize" | "toggleMaximize", label: string) =>
    desktop
      ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-label": label,
          onClick: () => handle(action),
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") handle(action);
          },
        }
      : {};

  const algorithmLabel = health.loading
    ? "连接算法…"
    : health.modelLoaded
      ? "Hybrid FBC 已就绪"
      : health.fallbackTrained
        ? "CSP+LDA 回退"
        : "未载入权重";

  return (
    <header className="titlebar">
      <div className={`traffic-lights ${desktop ? "is-functional" : ""}`} aria-hidden={!desktop}>
        <span className="light light-close" {...lightProps("close", "关闭窗口")} />
        <span className="light light-minimize" {...lightProps("minimize", "最小化")} />
        <span className="light light-zoom" {...lightProps("toggleMaximize", "最大化/还原")} />
      </div>
      <div className="titlebar-title">
        通韵 <span className="titlebar-sub">TongYun · 脑电莫尔斯输入</span>
      </div>
      <div className="titlebar-status">
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
