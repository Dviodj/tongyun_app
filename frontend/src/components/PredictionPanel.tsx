/** 单词预测小组件：只给出最可能的那一个，点击即可采用。 */
import { useMemo } from "react";
import { Sparkle } from "@phosphor-icons/react";
import { computePredictions, useAppStore } from "../state/store";

export function PredictionPanel() {
  const sentenceText = useAppStore((state) => state.sentenceText);
  const morseGroup = useAppStore((state) => state.morseGroup);

  const predictions = useMemo(
    () => computePredictions(useAppStore.getState()),
    [sentenceText, morseGroup],
  );

  const best = predictions.words[0];

  const applyWord = (word: string) => {
    const state = useAppStore.getState();
    const upper = word.toUpperCase();
    const parts = state.sentenceText.split(" ");
    const nextText = state.sentenceText.endsWith(" ")
      ? `${state.sentenceText}${upper}`
      : parts.length > 1
        ? `${parts.slice(0, -1).join(" ")} ${upper}`
        : upper;
    useAppStore.setState({ sentenceText: nextText, selectedWord: null, selectedSentence: null });
  };

  if (!best) return null;

  return (
    <div className="prediction-widget">
      <span className="widget-eyebrow">
        <Sparkle size={12} weight="fill" /> 最可能的下个单词
      </span>
      <button
        type="button"
        className="prediction-word-main"
        onClick={() => applyWord(best.value)}
        title={`点击采用「${best.value}」（置信度 ${Math.round(best.probability * 100)}%）`}
        aria-label={`采用预测单词 ${best.value}`}
      >
        <b>{best.value}</b>
        <span className="prediction-word-conf">{Math.round(best.probability * 100)}%</span>
        <span className="prediction-word-adopt">点击采用</span>
      </button>
    </div>
  );
}
