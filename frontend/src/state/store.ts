/** 全局状态：设置、会话、解码与预测。 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  decodeMorse,
  EVENT_DOT,
  EVENT_DASH,
  EVENT_LETTER_BOUNDARY,
  EVENT_REJECTED,
  EVENT_WORD_BOUNDARY,
} from "../lib/morse";
import {
  completeWord,
  suggestCorrections,
  type CorrectionSuggestion,
  type Prediction,
} from "../lib/predictor/engine";
import type { PredictResult, SourceMeta, WindowConfig } from "../api/client";

export type View = "main" | "window" | "settings";
export type ThemeMode = "light" | "dark" | "system";
export type LayoutMode = "stacked" | "split";
export type SessionStatus = "idle" | "playing" | "paused";
export type AppMode = "simulation" | "formal";

export interface PanelVisibility {
  sentence: boolean;
  word: boolean;
  morse: boolean;
  waveform: boolean;
}

export interface MorseEventItem {
  id: number;
  symbol: string;
  source: "algorithm" | "file" | "simulation" | "manual" | "live";
  confidence: number | null;
  accepted: boolean;
}

export interface SessionSlice {
  status: SessionStatus;
  mode: AppMode;
  live: { running: boolean; source: string | null; error: string | null; eventCount: number; decodedText: string };
  sentenceText: string;
  morseGroup: string[];
  morseHistory: MorseEventItem[];
  lastDecoded: { letter: string; morse: string } | null;
  lastRejection: { confidence: number; threshold: number } | null;
  selectedWord: string | null;
  selectedSentence: string | null;
  corrections: CorrectionSuggestion[];
  appliedCorrections: string[];
  source: SourceMeta | null;
  window: WindowConfig;
  threshold: number;
  algorithmHealth: { loading: boolean; modelLoaded: boolean; fallbackTrained: boolean; error: string | null };

  setStatus: (status: SessionStatus) => void;
  setMode: (mode: AppMode) => void;
  toggleMode: () => void;
  setLive: (live: Partial<SessionSlice["live"]>) => void;
  setSource: (source: SourceMeta | null) => void;
  setWindow: (window: WindowConfig) => void;
  setThreshold: (threshold: number) => void;
  setHealth: (health: { loading: boolean; modelLoaded: boolean; fallbackTrained: boolean; error: string | null }) => void;

  handleEvent: (code: number, meta?: { confidence?: number | null; source?: MorseEventItem["source"] }) => void;
  handlePredictResult: (result: PredictResult, source?: MorseEventItem["source"]) => void;
  addManualSymbol: (symbol: string) => void;
  commitLetter: (letter: string) => void;
  selectWord: (word: string | null) => void;
  selectSentence: (sentence: string | null) => void;
  confirmTop: () => void;
  cancelLast: () => void;
  togglePause: () => void;
  applyCorrection: (original: string, suggested: string) => void;
  ignoreCorrection: (original: string) => void;
  refreshCorrections: () => void;
  clearAll: () => void;
}

export interface SettingsSlice {
  view: View;
  theme: ThemeMode;
  accent: string;
  layout: LayoutMode;
  panels: PanelVisibility;
  setView: (view: View) => void;
  setTheme: (theme: ThemeMode) => void;
  setAccent: (accent: string) => void;
  setLayout: (layout: LayoutMode) => void;
  setPanel: (key: keyof PanelVisibility, visible: boolean) => void;
  resetSettings: () => void;
}

export interface AppState extends SessionSlice, SettingsSlice {}

let eventId = 0;

const DEFAULT_PANELS: PanelVisibility = {
  sentence: true,
  word: true,
  morse: true,
  waveform: true,
};

export const DEFAULT_WINDOW: WindowConfig = {
  tmin: 0.5,
  tmax: 4.0,
  duration: 3.5,
  samples: 351,
  bounds: [-1, 8],
  min_span: 0.25,
  trained_default: [0.5, 4.0],
};

const DEFAULT_ACCENTS = [
  { id: "blue", value: "#0a84ff" },
  { id: "purple", value: "#bf5af2" },
  { id: "pink", value: "#ff375f" },
  { id: "red", value: "#ff453a" },
  { id: "orange", value: "#ff9f0a" },
  { id: "yellow", value: "#ffd60a" },
  { id: "green", value: "#30d158" },
  { id: "graphite", value: "#8e8e93" },
];
export { DEFAULT_ACCENTS };

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // ---- 会话 ----
      status: "idle",
      mode: "simulation",
      live: { running: false, source: null, error: null, eventCount: 0, decodedText: "" },
      sentenceText: "",
      morseGroup: [],
      morseHistory: [],
      lastDecoded: null,
      lastRejection: null,
      selectedWord: null,
      selectedSentence: null,
      corrections: [],
      appliedCorrections: [],
      source: null,
      window: DEFAULT_WINDOW,
      threshold: 0.68,
      algorithmHealth: { loading: true, modelLoaded: false, fallbackTrained: false, error: null },

      setStatus: (status) => set({ status }),
      setMode: (mode) => set({ mode }),
      toggleMode: () => set({ mode: get().mode === "simulation" ? "formal" : "simulation" }),
      setLive: (live) => set({ live: { ...get().live, ...live } }),
      setSource: (source) => set({ source, status: "idle" }),
      setWindow: (window) => set({ window }),
      setThreshold: (threshold) => set({ threshold }),
      setHealth: (health) => set({ algorithmHealth: health }),

      handleEvent: (code, meta = {}) => {
        const state = get();
        const source =
          meta.source ?? (state.source?.source_mode === "simulation" ? "simulation" : "file");
        if (code === EVENT_DOT || code === EVENT_DASH) {
          const symbol = code === EVENT_DOT ? "." : "-";
          set({
            morseGroup: [...state.morseGroup, symbol],
            morseHistory: [
              ...state.morseHistory.slice(-79),
              {
                id: (eventId += 1),
                symbol,
                source,
                confidence: meta.confidence ?? null,
                accepted: true,
              },
            ],
            lastRejection: null,
          });
        } else if (code === EVENT_REJECTED) {
          set({
            lastRejection: {
              confidence: meta.confidence ?? 0,
              threshold: state.threshold,
            },
            morseHistory: [
              ...state.morseHistory.slice(-79),
              {
                id: (eventId += 1),
                symbol: "?",
                source,
                confidence: meta.confidence ?? null,
                accepted: false,
              },
            ],
          });
        } else if (code === EVENT_LETTER_BOUNDARY) {
          // 空点划组忽略（事件流文件可能以边界标记开头）
          if (state.morseGroup.length === 0) return;
          const letter = decodeMorse(state.morseGroup.join(""));
          set({
            sentenceText: state.sentenceText + letter,
            morseGroup: [],
            lastDecoded: { letter, morse: state.morseGroup.join("") },
          });
        } else if (code === EVENT_WORD_BOUNDARY) {
          const letter = state.morseGroup.length ? decodeMorse(state.morseGroup.join("")) : "";
          set({
            sentenceText:
              state.sentenceText + letter + (state.sentenceText.endsWith(" ") ? "" : " "),
            morseGroup: [],
            lastDecoded: letter ? { letter, morse: state.morseGroup.join("") } : state.lastDecoded,
          });
        }
      },

      handlePredictResult: (result, source = "algorithm") => {
        const state = get();
        if (!result.accepted) {
          set({
            lastRejection: { confidence: result.confidence, threshold: result.threshold },
            morseHistory: [
              ...state.morseHistory.slice(-79),
              {
                id: (eventId += 1),
                symbol: result.predicted_morse,
                source,
                confidence: result.confidence,
                accepted: false,
              },
            ],
          });
          return;
        }
        const symbol = result.morse ?? result.predicted_morse;
        set({
          morseGroup: [...state.morseGroup, symbol],
          morseHistory: [
            ...state.morseHistory.slice(-79),
            {
              id: (eventId += 1),
              symbol,
              source,
              confidence: result.confidence,
              accepted: true,
            },
          ],
          lastRejection: null,
        });
      },

      addManualSymbol: (symbol) => {
        const state = get();
        set({
          morseGroup: [...state.morseGroup, symbol],
          morseHistory: [
            ...state.morseHistory.slice(-79),
            {
              id: (eventId += 1),
              symbol,
              source: "manual",
              confidence: 1,
              accepted: true,
            },
          ],
        });
      },

      commitLetter: (letter) => {
        const state = get();
        set({
          sentenceText: state.sentenceText + letter,
          morseGroup: [],
          lastDecoded: { letter, morse: state.morseGroup.join("") },
        });
      },

      selectWord: (word) => set({ selectedWord: word, selectedSentence: null }),
      selectSentence: (sentence) => set({ selectedSentence: sentence, selectedWord: null }),

      confirmTop: () => {
        const state = get();
        const groupLetter = decodeMorse(state.morseGroup.join(""));
        if (state.morseGroup.length > 0 && groupLetter !== "?") {
          get().commitLetter(groupLetter);
          return;
        }
        if (state.selectedSentence) {
          set({ sentenceText: state.selectedSentence, selectedSentence: null, morseGroup: [] });
          return;
        }
        if (state.selectedWord) {
          const parts = state.sentenceText.split(" ");
          const last = parts[parts.length - 1] ?? "";
          const replacement = state.selectedWord.toUpperCase();
          const nextText = state.sentenceText.endsWith(" ")
            ? `${state.sentenceText}${replacement}`
            : `${parts.slice(0, -1).join(" ")}${parts.length > 1 ? " " : ""}${last.length ? last + replacement : replacement}`;
          set({ sentenceText: nextText, selectedWord: null, morseGroup: [] });
          return;
        }
        // 没有任何待确认项：把最后一个解码字母写入（幂等）
        if (state.lastDecoded && state.lastDecoded.letter !== "?") {
          get().commitLetter(state.lastDecoded.letter);
        }
      },

      cancelLast: () => {
        const state = get();
        if (state.morseGroup.length > 0) {
          set({ morseGroup: [], lastDecoded: null });
          return;
        }
        set({ sentenceText: state.sentenceText.slice(0, -1), selectedWord: null, selectedSentence: null });
      },

      togglePause: () => {
        const state = get();
        set({ status: state.status === "playing" ? "paused" : state.status === "paused" ? "playing" : state.status });
      },

      applyCorrection: (original, suggested) => {
        const state = get();
        set({
          sentenceText: state.sentenceText.replace(original, suggested),
          corrections: state.corrections.filter((item) => item.original !== original),
          appliedCorrections: [...state.appliedCorrections, `${original} → ${suggested}`],
        });
      },

      ignoreCorrection: (original) => {
        const state = get();
        set({
          corrections: state.corrections.filter((item) => item.original !== original),
        });
      },

      refreshCorrections: () => {
        const state = get();
        if (!state.sentenceText.trim()) {
          set({ corrections: [] });
          return;
        }
        set({ corrections: suggestCorrections(state.sentenceText) });
      },

      clearAll: () =>
        set({
          sentenceText: "",
          morseGroup: [],
          morseHistory: [],
          lastDecoded: null,
          lastRejection: null,
          selectedWord: null,
          selectedSentence: null,
          corrections: [],
          appliedCorrections: [],
          status: "idle",
        }),

      // ---- 设置 ----
      view: "main",
      theme: "light",
      accent: DEFAULT_ACCENTS[0].value,
      layout: "stacked",
      panels: DEFAULT_PANELS,

      setView: (view) => set({ view }),
      setTheme: (theme) => set({ theme }),
      setAccent: (accent) => set({ accent }),
      setLayout: (layout) => set({ layout }),
      setPanel: (key, visible) =>
        set({ panels: { ...get().panels, [key]: visible } }),
      resetSettings: () =>
        set({
          theme: "light",
          accent: DEFAULT_ACCENTS[0].value,
          layout: "stacked",
          panels: DEFAULT_PANELS,
        }),
    }),
    {
      name: "tongyun-app-settings",
      partialize: (state) => ({
        theme: state.theme,
        accent: state.accent,
        layout: state.layout,
        panels: state.panels,
        mode: state.mode,
      }),
    },
  ),
);

// ---------------------------------------------------------------------------
// 预测派生计算：只保留「下个单词」，且只取最可能的一个
// ---------------------------------------------------------------------------

export interface PredictionSet {
  words: Prediction[];
  currentWordPrefix: string;
  pendingLetter: string | null;
}

export function computePredictions(state: AppState): PredictionSet {
  const currentWord = state.sentenceText.split(" ").pop() ?? "";
  const morsePrefix = state.morseGroup.join("");
  const pendingLetter = morsePrefix ? decodeMorse(morsePrefix) : null;

  // 单一候选：当前单词未完成时补全，句尾空格时给出下一个词
  const words = completeWord(currentWord, 1);

  return { words, currentWordPrefix: currentWord, pendingLetter };
}
