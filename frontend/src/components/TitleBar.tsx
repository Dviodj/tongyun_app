/** macOS 风格标题栏：红黄绿交通灯 + 居中标题 + 右侧状态。桌面版中交通灯可点击。 */
import { Brain, WifiHigh, WifiSlash } from "@phosphor-icons/react";
import { useAppStore } from "../state/store";

export function TitleBar() {
  const health = useAppStore((state) => state.algorithmHealth);
  const status = useAppStore((state) => state.status);
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
        <span className={`status-pill ${health.modelLoaded ? "is-ready" : health.fallbackTrained ? "is-fallback" : "is-sim"}`}>
          {status === "playing" ? <WifiHigh size={13} weight="bold" /> : <Brain size={13} weight="bold" />}
          {health.loading
            ? "连接算法…"
            : health.modelLoaded
              ? "Hybrid FBC 已就绪"
              : health.fallbackTrained
                ? "CSP+LDA 回退模式"
                : "模拟模式"}
        </span>
        {status === "playing" ? (
          <span className="status-pill is-live">▶ 播放中</span>
        ) : status === "paused" ? (
          <span className="status-pill is-live">
            <WifiSlash size={13} weight="bold" /> 已暂停
          </span>
        ) : null}
      </div>
    </header>
  );
}
