/**
 * 轻量 n-gram 语言模型（1-gram + 2-gram，Kneser 风格退避）。
 * 数据来自 Norvig 英语语料（约 30000 词 / 40000 二元组），全部离线打包。
 */
import { WORDS, WORD_COUNTS } from "./data/words";
import { BIGRAM_A, BIGRAM_B, BIGRAM_COUNTS } from "./data/bigrams";
import { SENTENCE_TEMPLATES } from "./templates";
import { morsePrefixCandidates } from "../morse";

export interface Prediction {
  value: string;
  probability: number;
}

let wordIndex: Map<string, number> | null = null;
let prefixBuckets: Map<string, number[]> | null = null;
let bigramIndex: Map<number, Array<[number, number]>> | null = null;
let letterStartMass: Map<string, number> | null = null;
let totalMass = 0;

function ensureWordIndex(): Map<string, number> {
  if (wordIndex === null) {
    wordIndex = new Map(WORDS.map((word, index) => [word, index]));
  }
  return wordIndex;
}

/** 按「前两个字母」分桶，用于前缀补全（避免每次全表扫描）。 */
function ensurePrefixBuckets(): Map<string, number[]> {
  if (prefixBuckets === null) {
    prefixBuckets = new Map();
    WORDS.forEach((word, index) => {
      const key = word.slice(0, 2);
      const bucket = prefixBuckets!.get(key);
      if (bucket) bucket.push(index);
      else prefixBuckets!.set(key, [index]);
    });
  }
  return prefixBuckets;
}

function ensureBigramIndex(): Map<number, Array<[number, number]>> {
  if (bigramIndex === null) {
    bigramIndex = new Map();
    for (let i = 0; i < BIGRAM_A.length; i += 1) {
      const a = BIGRAM_A[i];
      const bucket = bigramIndex.get(a);
      if (bucket) bucket.push([BIGRAM_B[i], BIGRAM_COUNTS[i]]);
      else bigramIndex.set(a, [[BIGRAM_B[i], BIGRAM_COUNTS[i]]]);
    }
  }
  return bigramIndex;
}

function ensureLetterStartMass(): Map<string, number> {
  if (letterStartMass === null) {
    letterStartMass = new Map();
    totalMass = 0;
    WORDS.forEach((word, index) => {
      const count = WORD_COUNTS[index];
      totalMass += count;
      for (let length = 1; length <= Math.min(4, word.length); length += 1) {
        const key = word.slice(0, length);
        letterStartMass!.set(key, (letterStartMass!.get(key) ?? 0) + count);
      }
    });
  }
  return letterStartMass;
}

function normalize(entries: Array<[string, number]>, topK: number): Prediction[] {
  const sorted = entries.sort((a, b) => b[1] - a[1]).slice(0, topK);
  const sum = sorted.reduce((acc, [, score]) => acc + score, 0) || 1;
  return sorted.map(([value, score]) => ({
    value,
    probability: Math.round((score / sum) * 1000) / 1000,
  }));
}

/** 补全当前单词：给定已输入的前缀，返回最可能的完整单词。 */
export function completeWord(prefix: string, topK = 5): Prediction[] {
  const normalized = prefix.toLowerCase().replace(/[^a-z']/g, "");
  if (!normalized) return topUnigrams(topK);
  ensureWordIndex();
  ensurePrefixBuckets();
  const bucketKey = normalized.slice(0, 2);
  const candidates: Array<[string, number]> = [];
  if (bucketKey.length === 2) {
    for (const index of prefixBuckets!.get(bucketKey) ?? []) {
      const word = WORDS[index];
      if (word.startsWith(normalized) && word.length > normalized.length) {
        candidates.push([word, WORD_COUNTS[index]]);
      }
    }
  } else {
    // 单字母前缀：扫描高频词
    const limit = 4000;
    for (let index = 0; index < limit; index += 1) {
      const word = WORDS[index];
      if (word.startsWith(normalized) && word.length > normalized.length) {
        candidates.push([word, WORD_COUNTS[index]]);
      }
    }
  }
  return normalize(candidates, topK).map((entry) => ({
    value: entry.value.toUpperCase(),
    probability: entry.probability,
  }));
}

/** 前 K 高频词（无上下文时的回退）。 */
export function topUnigrams(topK = 5): Prediction[] {
  ensureWordIndex();
  const entries = WORDS.slice(0, 4000).map((word, index) => [word, WORD_COUNTS[index]] as [string, number]);
  return normalize(entries, topK).map((entry) => ({
    value: entry.value.toUpperCase(),
    probability: entry.probability,
  }));
}

/** 下一个单词：2-gram 主打分 + 1-gram 退避。 */
export function nextWord(contextWords: string[], topK = 5): Prediction[] {
  ensureWordIndex();
  ensureBigramIndex();
  const last = contextWords[contextWords.length - 1]?.toLowerCase().replace(/[^a-z']/g, "") ?? "";
  const lastIndex = last ? wordIndex!.get(last) : undefined;

  const scored: Array<[string, number]> = [];
  const seen = new Set<string>();
  if (lastIndex !== undefined) {
    const followers = bigramIndex!.get(lastIndex) ?? [];
    const totalFollowers = followers.reduce((acc, [, count]) => acc + count, 0);
    for (const [b, count] of followers) {
      const word = WORDS[b];
      if (seen.has(word)) continue;
      seen.add(word);
      const unigram = WORD_COUNTS[b];
      // 插值：上下文项 + 全局高频项
      const score = (0.75 * count) / Math.max(totalFollowers, 1) + (0.25 * unigram) / Math.max(totalMass, 1);
      scored.push([word, score]);
    }
  }
  // 退避：高频词兜底
  for (const word of ["the", "to", "you", "a", "i", "and", "is", "of", "in", "my"]) {
    const index = wordIndex!.get(word);
    if (index === undefined || seen.has(word)) continue;
    seen.add(word);
    scored.push([word, (0.25 * WORD_COUNTS[index]) / Math.max(totalMass, 1)]);
  }
  return normalize(scored, topK).map((entry) => ({
    value: entry.value.toUpperCase(),
    probability: entry.probability,
  }));
}

/**
 * 下一个字母：
 * - 正在输入点划（morsePrefix 非空）：候选字母按「以 wordPrefix+字母 开头的词频」排序；
 * - 点划为空：直接按词频预测下一个字母（前缀树概率）。
 */
export function nextLetter(morsePrefix: string, wordPrefix: string, topK = 5): Prediction[] {
  ensureLetterStartMass();
  const prefix = wordPrefix.toLowerCase().replace(/[^a-z']/g, "");
  const candidates = morsePrefix
    ? morsePrefixCandidates(morsePrefix)
    : "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

  const scored: Array<[string, number]> = [];
  for (const letter of candidates) {
    const key = (prefix + letter.toLowerCase()).slice(0, 4);
    let score: number;
    if (prefix.length > 0) {
      // 已有词前缀：只保留真实存在的续写
      score = letterStartMass!.get(key) ?? 0;
    } else {
      score = letterStartMass!.get(letter.toLowerCase()) ?? 1; // 首字母频率
    }
    if (score === 0) continue;
    if (morsePrefix && score > 0) {
      // 正在输点划时：优先码长最短（输入量最少）的字母
      score *= 1 + Math.max(0, 5 - (morsePrefixCandidates(morsePrefix).length - morsePrefix.length));
    }
    scored.push([letter, score]);
  }
  return normalize(scored, topK);
}

/** 下个句子：模板匹配 + 2-gram 束搜索扩展。 */
export function predictSentences(text: string, topK = 5): Prediction[] {
  const words = String(text || "")
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  const last = words[words.length - 1] ?? "";
  const lastTwo = words.slice(-2);

  const scored: Array<[string, number]> = [];
  const seen = new Set<string>();
  const normalizedText = String(text || "").toUpperCase().trim();
  for (const template of SENTENCE_TEMPLATES) {
    if (seen.has(template)) continue;
    const templateWords = template.split(" ");
    let score = 0.004;
    // 模板以当前整句开头：最强信号
    if (normalizedText && template.startsWith(normalizedText) && template !== normalizedText) {
      score *= 25;
    }
    if (last && templateWords[0] === last) score *= 3;
    if (lastTwo.length === 2 && templateWords.length >= 2 &&
        templateWords[0] === lastTwo[0] && templateWords[1] === lastTwo[1]) {
      score *= 6;
    }
    scored.push([template, score]);
    seen.add(template);
  }

  // 束扩展：从最后一个词往后接 2-gram
  if (last) {
    const beams: Array<{ words: string[]; prob: number }> = [{ words: [last], prob: 1 }];
    for (let step = 0; step < 3; step += 1) {
      const nextBeams: typeof beams = [];
      for (const beam of beams) {
        const followers = nextWord(beam.words);
        for (const follower of followers.slice(0, 3)) {
          nextBeams.push({
            words: [...beam.words, follower.value],
            prob: beam.prob * follower.probability,
          });
        }
      }
      nextBeams.sort((a, b) => b.prob - a.prob);
      beams.length = 0;
      beams.push(...nextBeams.slice(0, 6));
    }
    for (const beam of beams) {
      if (beam.words.length < 2) continue;
      const sentence = [...words.slice(0, -1), ...beam.words].join(" ");
      if (seen.has(sentence)) continue;
      seen.add(sentence);
      scored.push([sentence, beam.prob * 0.35]);
    }
  }

  return normalize(scored, topK).slice(0, topK);
}

export interface CorrectionSuggestion {
  original: string;
  suggested: string;
  confidence: number;
  editDistance: number;
}

/** 词表 + 编辑距离的拼写纠错（不超过 2 个编辑）。 */
export function suggestCorrections(text: string, maxSuggestions = 3): CorrectionSuggestion[] {
  const words = String(text || "").toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  ensureWordIndex();
  const suggestions: CorrectionSuggestion[] = [];
  for (const word of words) {
    const normalized = word.toLowerCase();
    if (word.length < 2 || wordIndex!.has(normalized)) continue;
    let best: { word: string; distance: number } | null = null;
    const limit = Math.min(WORDS.length, 12000);
    for (let index = 0; index < limit; index += 1) {
      const candidate = WORDS[index];
      if (Math.abs(candidate.length - normalized.length) > 2) continue;
      const distance = boundedLevenshtein(normalized, candidate, 2);
      if (distance === null) continue;
      if (best === null || distance < best.distance) {
        best = { word: candidate, distance };
      }
    }
    if (best && best.distance > 0) {
      suggestions.push({
        original: word,
        suggested: best.word.toUpperCase(),
        confidence: Math.round(Math.max(0.7, 0.98 - best.distance * 0.12) * 1000) / 1000,
        editDistance: best.distance,
      });
    }
  }
  return suggestions.slice(0, maxSuggestions);
}

/** 带剪枝的编辑距离；超过 cap 返回 null。 */
function boundedLevenshtein(left: string, right: string, cap: number): number | null {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      const value = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > cap) return null;
    previous.length = 0;
    previous.push(...current);
  }
  return previous[right.length] <= cap ? previous[right.length] : null;
}
