// 把 Norvig n-gram 语料转成前端可打包的 TS 数据模块。
// 输入: scripts/count_1w.txt (word\tcount), scripts/count_2w.txt (word1 word2\tcount)
// 输出: src/lib/predictor/data/words.ts 与 bigrams.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "lib", "predictor", "data");
mkdirSync(outDir, { recursive: true });

const MAX_WORDS = 30000;
const MAX_BIGRAMS = 40000;
const WORD_RE = /^[a-z]{1,20}$/;

// ---- 1-gram ----
const unigrams = readFileSync(join(here, "count_1w.txt"), "utf8")
  .split("\n")
  .map((line) => {
    const tab = line.indexOf("\t");
    if (tab < 0) return null;
    const word = line.slice(0, tab).toLowerCase();
    const count = Number(line.slice(tab + 1));
    if (!WORD_RE.test(word) || !Number.isFinite(count)) return null;
    // 单字母词只保留 a / i
    if (word.length === 1 && word !== "a" && word !== "i") return null;
    return { word, count };
  })
  .filter(Boolean)
  .sort((a, b) => b.count - a.count)
  .slice(0, MAX_WORDS);

const wordIndex = new Map(unigrams.map((entry, index) => [entry.word, index]));
const WORDS = unigrams.map((entry) => entry.word);
const WORD_COUNTS = unigrams.map((entry) => entry.count);

// ---- 2-gram ----
const triples = [];
for (const line of readFileSync(join(here, "count_2w.txt"), "utf8").split("\n")) {
  if (triples.length >= MAX_BIGRAMS) break;
  const tab = line.indexOf("\t");
  if (tab < 0) continue;
  const pair = line.slice(0, tab).toLowerCase().split(" ");
  const count = Number(line.slice(tab + 1));
  if (pair.length !== 2 || !Number.isFinite(count)) continue;
  const a = wordIndex.get(pair[0]);
  const b = wordIndex.get(pair[1]);
  if (a === undefined || b === undefined) continue;
  triples.push([a, b, count]);
}

const BIGRAM_A = triples.map(([a]) => a);
const BIGRAM_B = triples.map(([, b]) => b);
const BIGRAM_COUNTS = triples.map(([, , c]) => c);

// ---- 写入 ----
function emitTs(path, body) {
  writeFileSync(path, "// 自动生成，请勿手改。由 scripts/build-lm-data.mjs 生成。\n" + body, "utf8");
}

emitTs(
  join(outDir, "words.ts"),
  `export const WORDS: readonly string[] = ${JSON.stringify(WORDS)};\n` +
    `export const WORD_COUNTS: readonly number[] = [${WORD_COUNTS.join(",")}];\n`,
);
emitTs(
  join(outDir, "bigrams.ts"),
  `export const BIGRAM_A: readonly number[] = [${BIGRAM_A.join(",")}];\n` +
    `export const BIGRAM_B: readonly number[] = [${BIGRAM_B.join(",")}];\n` +
    `export const BIGRAM_COUNTS: readonly number[] = [${BIGRAM_COUNTS.join(",")}];\n`,
);

const wordsBytes = Buffer.byteLength(
  JSON.stringify(WORDS) + WORD_COUNTS.join(",") + BIGRAM_A.join(",") + BIGRAM_B.join(",") + BIGRAM_COUNTS.join(","),
);
console.log(
  `words=${WORDS.length} bigrams=${BIGRAM_A.length} approx-bytes=${(wordsBytes / 1024).toFixed(0)}KB`,
);
