/** 主页面：板块以桌面小组件方式无缝拼接（无大标题）。 */
import { Check, Pause, Play, Trash, X } from "@phosphor-icons/react";
import { useAppStore } from "../state/store";
import { Button } from "./ui";
import { SentencePanel } from "./SentencePanel";
import { PredictionPanel } from "./PredictionPanel";
import { MorsePanel } from "./MorsePanel";
import { WaveformPanel } from "./WaveformPanel";

export function MainView() {
  const panels = useAppStore((state) => state.panels);
  const layout = useAppStore((state) => state.layout);
  const status = useAppStore((state) => state.status);
  const confirmTop = useAppStore((state) => state.confirmTop);
  const cancelLast = useAppStore((state) => state.cancelLast);
  const togglePause = useAppStore((state) => state.togglePause);
  const clearAll = useAppStore((state) => state.clearAll);

  const bottomVisible = panels.morse || panels.waveform;

  return (
    <div className="main-view">
      <div className="widget-stack widget-stack-top">
        {panels.sentence && <SentencePanel />}
        {panels.word && <PredictionPanel />}
        <div className="widget-actions action-bar" aria-label="确认 / 取消 / 暂停">
          <Button
            variant="primary"
            className="action-confirm"
            onClick={confirmTop}
            title="确认当前字母（Enter）"
          >
            <Check size={17} weight="bold" /> 确定
          </Button>
          <Button variant="default" className="action-cancel" onClick={cancelLast} title="取消当前点划组或撤销上一个字符（Backspace）">
            <X size={17} weight="bold" /> 取消
          </Button>
          <Button
            variant="default"
            className="action-pause"
            onClick={togglePause}
            title="暂停 / 继续回放"
          >
            {status === "playing" ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}
            {status === "playing" ? "暂停" : status === "paused" ? "继续" : "播放"}
          </Button>
          <div className="action-spacer" />
          <Button variant="quiet" className="action-clear" onClick={clearAll} title="清空全部输入">
            <Trash size={15} /> 清空
          </Button>
        </div>
      </div>

      {bottomVisible && layout === "split" ? (
        <div className="main-bottom is-split">
          {panels.morse && (
            <div className="widget-stack split-item">
              <MorsePanel />
            </div>
          )}
          {panels.waveform && (
            <div className="widget-stack split-item">
              <WaveformPanel />
            </div>
          )}
        </div>
      ) : bottomVisible ? (
        <div className="widget-stack widget-stack-bottom">
          {panels.morse && <MorsePanel />}
          {panels.waveform && <WaveformPanel />}
        </div>
      ) : null}
    </div>
  );
}
