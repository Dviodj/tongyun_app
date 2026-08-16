/** 三层预测：下个字母 / 下个单词 / 下个句子。 */
import { useMemo } from "react";
import { ArrowBendDownRight, LetterCircleV, TextT } from "@phosphor-icons/react";
import { computePredictions, useAppStore } from "../state/store";
import { Card, Chip, SectionHeader } from "./ui";

export function PredictionPanel() {
  const sentenceText = useAppStore((state) => state.sentenceText);
  const morseGroup = useAppStore((state) => state.morseGroup);
  const selectedWord = useAppStore((state) => state.selectedWord);
  const selectedSentence = useAppStore((state) => state.selectedSentence);
  const commitLetter = useAppStore((state) => state.commitLetter);
  const selectWord = useAppStore((state) => state.selectWord);
  const selectSentence = useAppStore((state) => state.selectSentence);
  const panels = useAppStore((state) => state.panels);

  const predictions = useMemo(
    () => computePredictions(useAppStore.getState()),
    [sentenceText, morseGroup],
  );

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

  const applySentence = (sentence: string) => {
    useAppStore.setState({ sentenceText: sentence, selectedSentence: null, selectedWord: null });
  };

  const anyVisible = panels.letter || panels.word || panels.sentencePred;
  if (!anyVisible) return null;

  return (
    <Card className="prediction-card">
      <SectionHeader
        title="智能预测"
        subtitle="n-gram 语言模型 · 离线本地推理，点击即可采用"
      />

      {panels.letter && (
        <div className="prediction-row">
          <div className="prediction-row-label">
            <LetterCircleV size={17} weight="duotone" />
            <span>下个字母</span>
          </div>
          <div className="prediction-chips">
            {predictions.letters.map((item) => (
              <Chip
                key={item.value}
                className="chip-letter"
                onClick={() => commitLetter(item.value)}
                title={`置信度 ${Math.round(item.probability * 100)}%`}
              >
                <b>{item.value}</b>
                <small>{Math.round(item.probability * 100)}%</small>
              </Chip>
            ))}
            {predictions.pendingLetter && predictions.pendingLetter !== "?" && (
              <Chip className="chip-pending-letter">
                当前 <b>{predictions.pendingLetter}</b> · 按「确定」写入
              </Chip>
            )}
          </div>
        </div>
      )}

      {panels.word && (
        <div className="prediction-row">
          <div className="prediction-row-label">
            <TextT size={17} weight="duotone" />
            <span>下个单词</span>
          </div>
          <div className="prediction-chips">
            {predictions.words.map((item) => (
              <Chip
                key={item.value}
                className="chip-word"
                selected={selectedWord === item.value}
                onClick={() => {
                  if (selectedWord === item.value) applyWord(item.value);
                  else selectWord(item.value);
                }}
                title={`置信度 ${Math.round(item.probability * 100)}%`}
              >
                <b>{item.value}</b>
                <small>{Math.round(item.probability * 100)}%</small>
              </Chip>
            ))}
            {selectedWord && (
              <Chip className="chip-selected-word">
                已选 <b>{selectedWord}</b> · 再点一次或按「确定」
              </Chip>
            )}
          </div>
        </div>
      )}

      {panels.sentencePred && (
        <div className="prediction-row">
          <div className="prediction-row-label">
            <ArrowBendDownRight size={17} weight="duotone" />
            <span>下个句子</span>
          </div>
          <div className="prediction-chips prediction-chips-sentence">
            {predictions.sentences.map((item) => (
              <Chip
                key={item.value}
                className="chip-sentence"
                selected={selectedSentence === item.value}
                onClick={() => {
                  if (selectedSentence === item.value) applySentence(item.value);
                  else selectSentence(item.value);
                }}
                title={`置信度 ${Math.round(item.probability * 100)}%`}
              >
                <b>{item.value}</b>
                <small>{Math.round(item.probability * 100)}%</small>
              </Chip>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
