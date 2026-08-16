/** 设置：外观（颜色/主题）、布局、板块显隐、解码参数。 */
import { useState } from "react";
import {
  ArrowCounterClockwise,
  Brain,
  Check,
  Layout,
  Moon,
  Palette,
  Sun,
  TextT,
  Waveform,
} from "@phosphor-icons/react";
import { setThreshold as apiSetThreshold } from "../api/client";
import { DEFAULT_ACCENTS, useAppStore, type PanelVisibility } from "../state/store";
import { Button, Card, SectionHeader, Segmented, Toggle } from "./ui";

const PANEL_ITEMS: Array<{
  key: keyof PanelVisibility;
  label: string;
  hint: string;
  icon: typeof Brain;
}> = [
  { key: "sentence", label: "识别句子", hint: "主显示区：解码句子与纠错建议", icon: Brain },
  { key: "word", label: "下个单词预测", hint: "最可能的下一个单词", icon: TextT },
  { key: "morse", label: "莫尔斯码", hint: "点划流、当前字母与手动输入", icon: Waveform },
  { key: "waveform", label: "源文件波形", hint: "三通道波形、事件标记与回放", icon: Layout },
];

export function SettingsView() {
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const accent = useAppStore((state) => state.accent);
  const setAccent = useAppStore((state) => state.setAccent);
  const layout = useAppStore((state) => state.layout);
  const setLayout = useAppStore((state) => state.setLayout);
  const panels = useAppStore((state) => state.panels);
  const setPanel = useAppStore((state) => state.setPanel);
  const resetSettings = useAppStore((state) => state.resetSettings);
  const threshold = useAppStore((state) => state.threshold);
  const setThresholdStore = useAppStore((state) => state.setThreshold);
  const health = useAppStore((state) => state.algorithmHealth);

  const [thresholdDraft, setThresholdDraft] = useState(threshold);
  const [thresholdApplied, setThresholdApplied] = useState(false);
  const [thresholdError, setThresholdError] = useState<string | null>(null);

  const applyThreshold = async () => {
    setThresholdError(null);
    try {
      const result = await apiSetThreshold(thresholdDraft);
      setThresholdStore(result.confidence_threshold);
      setThresholdApplied(true);
      window.setTimeout(() => setThresholdApplied(false), 2000);
    } catch (error) {
      setThresholdError((error as Error).message);
    }
  };

  return (
    <div className="settings-view">
      <Card className="settings-card">
        <SectionHeader title="外观" subtitle="主题与强调色" aside={<Palette size={20} weight="duotone" />} />
        <div className="settings-row">
          <span className="settings-label">主题模式</span>
          <Segmented
            ariaLabel="主题模式"
            options={[
              { value: "light", label: <><Sun size={13} weight="duotone" /> 浅色</> },
              { value: "dark", label: <><Moon size={13} weight="duotone" /> 深色</> },
              { value: "system", label: "跟随系统" },
            ]}
            value={theme}
            onChange={setTheme}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">强调色</span>
          <div className="accent-swatches" role="radiogroup" aria-label="强调色">
            {DEFAULT_ACCENTS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={accent === item.value}
                aria-label={`强调色 ${item.id}`}
                className={`accent-swatch ${accent === item.value ? "is-active" : ""}`}
                style={{ background: item.value }}
                onClick={() => setAccent(item.value)}
              >
                {accent === item.value && <Check size={13} weight="bold" color="#fff" />}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card className="settings-card">
        <SectionHeader title="布局" subtitle="主页面下半区的排列方式" aside={<Layout size={20} weight="duotone" />} />
        <div className="settings-row">
          <span className="settings-label">莫尔斯码与波形</span>
          <Segmented
            ariaLabel="布局方式"
            options={[
              { value: "stacked", label: "上下堆叠" },
              { value: "split", label: "左右并排" },
            ]}
            value={layout}
            onChange={setLayout}
          />
        </div>
      </Card>

      <Card className="settings-card">
        <SectionHeader title="板块显隐" subtitle="选择主页面显示哪些板块" aside={<Layout size={20} weight="duotone" />} />
        <div className="panel-toggle-list">
          {PANEL_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <div className="panel-toggle-row" key={item.key}>
                <span className="panel-toggle-icon">
                  <Icon size={17} weight="duotone" />
                </span>
                <span className="panel-toggle-copy">
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </span>
                <Toggle
                  checked={panels[item.key]}
                  onChange={(visible) => setPanel(item.key, visible)}
                  label={`显示${item.label}`}
                />
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="settings-card">
        <SectionHeader title="解码" subtitle="置信门控与算法状态" aside={<Brain size={20} weight="duotone" />} />
        <div className="settings-row">
          <span className="settings-label">置信门控阈值</span>
          <div className="threshold-control">
            <input
              type="range"
              min={0.5}
              max={0.95}
              step={0.01}
              value={thresholdDraft}
              onChange={(event) => setThresholdDraft(Number(event.target.value))}
              aria-label="置信门控阈值"
              style={{ "--accent": accent } as React.CSSProperties}
            />
            <b>{Math.round(thresholdDraft * 100)}%</b>
            <Button
              variant={thresholdApplied ? "success" : "primary"}
              onClick={() => void applyThreshold()}
              disabled={thresholdApplied}
            >
              {thresholdApplied ? <><Check size={14} weight="bold" /> 已应用</> : "应用"}
            </Button>
          </div>
        </div>
        {thresholdError && <p className="settings-error">{thresholdError}</p>}
        <div className="algorithm-facts">
          <div><span>算法</span><b>{health.loading ? "连接中…" : health.modelLoaded ? "Hybrid FBC-MIFormer（权重已加载）" : health.fallbackTrained ? "CSP+LDA 回退分类器" : "模拟模式（无部署权重）"}</b></div>
          <div><span>输入规格</span><b>3 × 351 @ 100 Hz（C3 / Cz / C4）</b></div>
          <div><span>事件映射</span><b>左手 = 点 · 右手 = 划</b></div>
          {health.error && <div><span>提示</span><b className="sim">{health.error}</b></div>}
        </div>
      </Card>

      <Card className="settings-card">
        <div className="settings-row settings-row-reset">
          <span className="settings-label">
            恢复默认设置
            <small>主题、强调色、布局与板块显隐将还原为初始值</small>
          </span>
          <Button variant="default" onClick={resetSettings}>
            <ArrowCounterClockwise size={15} /> 重置
          </Button>
        </div>
      </Card>
    </div>
  );
}
