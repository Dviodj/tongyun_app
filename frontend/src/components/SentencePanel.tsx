/** 识别句子面板：主显示区 + 纠错建议 + 当前解码状态。 */
import { ArrowRight, Check, Sparkle, X } from "@phosphor-icons/react";
import { useAppStore } from "../state/store";
import { decodeMorse } from "../lib/morse";
import { Card, Chip, EmptyHint, SectionHeader } from "./ui";

export function SentencePanel() {
  const sentenceText = useAppStore((state) => state.sentenceText);
  const morseGroup = useAppStore((state) => state.morseGroup);
  const lastDecoded = useAppStore((state) => state.lastDecoded);
  const lastRejection = useAppStore((state) => state.lastRejection);
  const corrections = useAppStore((state) => state.corrections);
  const appliedCorrections = useAppStore((state) => state.appliedCorrections);
  const applyCorrection = useAppStore((state) => state.applyCorrection);
  const ignoreCorrection = useAppStore((state) => state.ignoreCorrection);

  return (
    <Card className="sentence-card">
      <SectionHeader
        title="识别句子"
        subtitle="由脑电信号解码生成，AI 预测不会自动覆盖原文"
        aside={
          lastRejection ? (
            <Chip className="chip-reject">
              低置信已拒绝 {Math.round(lastRejection.confidence * 100)}% &lt;{" "}
              {Math.round(lastRejection.threshold * 100)}%
            </Chip>
          ) : lastDecoded ? (
            <Chip className="chip-decoded">
              最近解码 {lastDecoded.letter} · {lastDecoded.morse || "—"}
            </Chip>
          ) : null
        }
      />

      <div className="sentence-stage" aria-live="polite">
        <span className="sentence-text">
          {sentenceText ? sentenceText : <span className="sentence-placeholder">等待脑电输入…</span>}
        </span>
        {morseGroup.length > 0 && (
          <span className="sentence-pending" title="当前点划组，按「确定」写入句子">
            <span className="pending-morse">{morseGroup.join("")}</span>
            <ArrowRight size={13} />
            <span className="pending-letter">{decodeMorse(morseGroup.join(""))}</span>
          </span>
        )}
        <span className="sentence-caret" aria-hidden="true" />
      </div>

      {corrections.length > 0 && (
        <div className="correction-strip" role="status">
          <Sparkle size={15} weight="fill" />
          <span>
            {corrections.map((item) => (
              <span className="correction-item" key={item.original}>
                疑似拼写：<b className="wrong">{item.original}</b>
                <ArrowRight size={13} />
                <b className="right">{item.suggested}</b>
                <span className="correction-conf">{Math.round(item.confidence * 100)}%</span>
                <button
                  type="button"
                  className="btn btn-quiet btn-xs"
                  onClick={() => applyCorrection(item.original, item.suggested)}
                >
                  <Check size={12} /> 接受
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-xs"
                  onClick={() => ignoreCorrection(item.original)}
                >
                  <X size={12} /> 忽略
                </button>
              </span>
            ))}
          </span>
        </div>
      )}

      {appliedCorrections.length > 0 && (
        <div className="applied-strip">
          {appliedCorrections.map((record, index) => (
            <Chip key={`${record}-${index}`} className="chip-applied">
              <Check size={12} weight="bold" /> 已更正 {record}
            </Chip>
          ))}
        </div>
      )}

      {sentenceText.length === 0 && morseGroup.length === 0 && (
        <EmptyHint>按「▶ 播放」回放源文件，或在下方手动输入点划（. / -）体验解码与预测</EmptyHint>
      )}
    </Card>
  );
}
