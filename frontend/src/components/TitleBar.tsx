/** macOS 风格标题栏：红黄绿交通灯 + 居中标题 + 右侧状态。 */
import { Brain, WifiHigh, WifiSlash } from "@phosphor-icons/react";
import { useAppStore } from "../state/store";

export function TitleBar() {
  const health = useAppStore((state) => state.algorithmHealth);
  const status = useAppStore((state) => state.status);

  return (
    <header className="titlebar">
      <div className="traffic-lights" aria-hidden="true">
        <span className="light light-close" />
        <span className="light light-minimize" />
        <span className="light light-zoom" />
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
