/** 左侧控制栏：主页面 / 时间窗 / 设置 + 底部算法状态。 */
import { GearSix, House, Waveform } from "@phosphor-icons/react";
import { useAppStore, type View } from "../state/store";

const NAV_ITEMS: Array<{ view: View; label: string; hint: string; icon: typeof House }> = [
  { view: "main", label: "主页面", hint: "识别与预测", icon: House },
  { view: "window", label: "时间窗调整", hint: "解码窗口", icon: Waveform },
  { view: "settings", label: "设置", hint: "外观与布局", icon: GearSix },
];

export function Sidebar() {
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const health = useAppStore((state) => state.algorithmHealth);
  const windowConfig = useAppStore((state) => state.window);
  const threshold = useAppStore((state) => state.threshold);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-badge">
          <span>通</span>
        </div>
        <div className="brand-copy">
          <strong>通韵</strong>
          <span>TongYun BCI</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="功能导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.view}
              type="button"
              className={`nav-item ${view === item.view ? "is-active" : ""}`}
              onClick={() => setView(item.view)}
              aria-current={view === item.view ? "page" : undefined}
            >
              <span className="nav-icon">
                <Icon size={19} weight={view === item.view ? "fill" : "regular"} />
              </span>
              <span className="nav-copy">
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="mini-status">
          <div className="mini-status-row">
            <span>解码窗口</span>
            <b>
              {windowConfig.tmin}–{windowConfig.tmax} s
            </b>
          </div>
          <div className="mini-status-row">
            <span>置信门控</span>
            <b>{Math.round(threshold * 100)}%</b>
          </div>
          <div className="mini-status-row">
            <span>算法</span>
            <b className={health.modelLoaded ? "ok" : health.fallbackTrained ? "warn" : "sim"}>
              {health.loading ? "连接中…" : health.modelLoaded ? "FBC-MIFormer" : health.fallbackTrained ? "CSP+LDA" : "模拟"}
            </b>
          </div>
        </div>
      </div>
    </aside>
  );
}
