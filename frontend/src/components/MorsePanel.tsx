/** 莫尔斯码面板：符号流 + 当前点划组 + 手动输入。 */
import { useEffect } from "react";
import { Backspace, Minus } from "@phosphor-icons/react";
import { useAppStore } from "../state/store";
import { decodeMorse } from "../lib/morse";
import { Button, Card, SectionHeader } from "./ui";

export function MorsePanel() {
  const morseHistory = useAppStore((state) => state.morseHistory);
  const morseGroup = useAppStore((state) => state.morseGroup);
  const addManualSymbol = useAppStore((state) => state.addManualSymbol);
  const cancelLast = useAppStore((state) => state.cancelLast);
  const confirmTop = useAppStore((state) => state.confirmTop);

  // 键盘输入：. 或 ← 为点，- 或 → 为划，Enter 确认，Backspace 取消
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "." || event.key === "ArrowLeft") {
        event.preventDefault();
        addManualSymbol(".");
      } else if (event.key === "-" || event.key === "ArrowRight") {
        event.preventDefault();
        addManualSymbol("-");
      } else if (event.key === "Enter") {
        event.preventDefault();
        confirmTop();
      } else if (event.key === "Backspace") {
        event.preventDefault();
        cancelLast();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addManualSymbol, confirmTop, cancelLast]);

  const groupLetter = decodeMorse(morseGroup.join(""));

  return (
    <Card className="morse-card">
      <SectionHeader
        title="识别莫尔斯码"
        subtitle="左手=点 · 右手=划"
        aside={
          <div className="manual-input" aria-label="手动输入点划">
            <Button variant="quiet" onClick={() => addManualSymbol(".")} title="输入点 (键盘 . 或 ←)">
              <span className="dot-symbol" /> 点
            </Button>
            <Button variant="quiet" onClick={() => addManualSymbol("-")} title="输入划 (键盘 - 或 →)">
              <Minus size={15} weight="bold" /> 划
            </Button>
            <Button variant="quiet" onClick={cancelLast} title="撤销 (键盘 Backspace)">
              <Backspace size={15} /> 撤销
            </Button>
          </div>
        }
      />

      <div className="morse-stage">
        <div className="morse-group" aria-live="polite">
          <span className="morse-group-label">当前字母</span>
          <span className="morse-group-symbols">
            {morseGroup.length ? (
              morseGroup.map((symbol, index) =>
                symbol === "." ? (
                  <span className="large-dot" key={`${symbol}-${index}`} />
                ) : (
                  <span className="large-dash" key={`${symbol}-${index}`} />
                ),
              )
            ) : (
              <span className="morse-group-empty">等待点划…</span>
            )}
          </span>
          <span className={`morse-group-letter ${groupLetter === "?" ? "is-unknown" : ""}`}>
            {groupLetter === "?" ? "?" : groupLetter || "—"}
          </span>
        </div>

        <div className="morse-stream" aria-label="最近识别的点划序列">
          {(() => {
            const visible = morseHistory.slice(-28);
            const lastId = morseHistory.length ? morseHistory[morseHistory.length - 1].id : null;
            return (visible.length ? visible : Array.from({ length: 28 }, () => null)).map(
              (item, index) => (
                <span
                  key={item ? item.id : `empty-${index}`}
                  className={`stream-cell ${item ? (item.accepted ? "is-accepted" : "is-rejected") : "is-empty"} ${
                    item && item.id === lastId ? "is-latest" : ""
                  }`}
                  title={
                    item
                      ? `置信度 ${item.confidence != null ? `${Math.round(item.confidence * 100)}%` : "—"} · 来源 ${item.source}`
                      : undefined
                  }
                >
                  {item ? (item.symbol === "." ? <i className="dot-symbol" /> : <i className="dash-symbol" />) : null}
                </span>
              ),
            );
          })()}
        </div>
      </div>

      <div className="morse-reference" aria-hidden="true">
        A ·—　B —···　C —·—·　D —··　E ·　F ··—·　G ——·　H ····　I ··　J ·———　K —·—　L ·—··　M ——　N —·
      </div>
    </Card>
  );
}
