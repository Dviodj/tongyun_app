/** 应用外壳：标题栏 + 左侧控制栏 + 右侧内容区。 */
import { useEffect } from "react";
import { getHealth, getWindow } from "./api/client";
import { useAppStore } from "./state/store";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { MainView } from "./components/MainView";
import { TimeWindowView } from "./components/TimeWindowView";
import { SettingsView } from "./components/SettingsView";

/** 读取 URL 参数（支持跟在 #hash 之后的 ?query，用于深链接）。 */
export function getHashParams(): URLSearchParams {
  const hash = window.location.hash || "";
  const query = hash.includes("?")
    ? hash.slice(hash.indexOf("?") + 1)
    : window.location.search.slice(1);
  return new URLSearchParams(query);
}

export function App() {
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const accent = useAppStore((state) => state.accent);
  const setHealth = useAppStore((state) => state.setHealth);
  const setWindow = useAppStore((state) => state.setWindow);
  const setThreshold = useAppStore((state) => state.setThreshold);
  const sentenceText = useAppStore((state) => state.sentenceText);
  const refreshCorrections = useAppStore((state) => state.refreshCorrections);

  // URL 哈希路由：#main / #window / #settings（参数跟在 # 后：?demo=…&theme=…）
  useEffect(() => {
    const applyHash = () => {
      const hash = (window.location.hash || "").replace(/^#/, "").split("?")[0];
      if (hash === "main" || hash === "window" || hash === "settings") {
        setView(hash);
      }
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [setView]);

  // URL 主题参数：?theme=dark / light / system（便于分享与截图）
  useEffect(() => {
    const params = getHashParams();
    const themeParam = params.get("theme");
    if (themeParam === "dark" || themeParam === "light" || themeParam === "system") {
      setTheme(themeParam);
    }
  }, [setTheme]);

  useEffect(() => {
    window.history.replaceState(null, "", `#${view}`);
  }, [view]);

  // 主题与强调色
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", accent);
  }, [accent]);

  // 初始算法状态
  useEffect(() => {
    let active = true;
    void getHealth()
      .then((health) => {
        if (!active) return;
        setHealth({
          loading: false,
          modelLoaded: health.model_loaded,
          fallbackTrained: health.fallback?.trained ?? false,
          error: health.error ?? null,
        });
        setThreshold(health.confidence_threshold);
      })
      .catch(() => {
        if (!active) return;
        setHealth({
          loading: false,
          modelLoaded: false,
          fallbackTrained: false,
          error: "本地算法服务未启动：请运行 backend/backend.py",
        });
      });
    void getWindow()
      .then((window) => active && setWindow(window))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [setHealth, setThreshold, setWindow]);

  // 句子完成后（停顿）自动做拼写检查
  useEffect(() => {
    const timer = window.setTimeout(() => refreshCorrections(), 700);
    return () => window.clearTimeout(timer);
  }, [sentenceText, refreshCorrections]);

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <main className="content-area">
          {view === "main" && <MainView />}
          {view === "window" && <TimeWindowView />}
          {view === "settings" && <SettingsView />}
        </main>
      </div>
    </div>
  );
}
