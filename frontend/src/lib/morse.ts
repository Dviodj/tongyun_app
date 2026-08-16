/** 莫尔斯码表与工具。左手=点(.)，右手=划(-)。 */

export const MORSE_TO_TEXT: Readonly<Record<string, string>> = {
  ".-": "A", "-...": "B", "-.-.": "C", "-..": "D", ".": "E",
  "..-.": "F", "--.": "G", "....": "H", "..": "I", ".---": "J",
  "-.-": "K", ".-..": "L", "--": "M", "-.": "N", "---": "O",
  ".--.": "P", "--.-": "Q", ".-.": "R", "...": "S", "-": "T",
  "..-": "U", "...-": "V", ".--": "W", "-..-": "X", "-.--": "Y",
  "--..": "Z", "-----": "0", ".----": "1", "..---": "2", "...--": "3",
  "....-": "4", ".....": "5", "-....": "6", "--...": "7", "---..": "8",
  "----.": "9",
};

export const TEXT_TO_MORSE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MORSE_TO_TEXT).map(([morse, text]) => [text, morse]),
);

/** 当前点划前缀可能解码成的字母，按码长排序。 */
export function morsePrefixCandidates(prefix: string): string[] {
  return Object.entries(MORSE_TO_TEXT)
    .filter(([morse]) => morse.startsWith(prefix))
    .sort((a, b) => a[0].length - b[0].length || a[1].localeCompare(b[1]))
    .map(([, letter]) => letter);
}

/** 解码单个点划序列。 */
export function decodeMorse(morse: string): string {
  return MORSE_TO_TEXT[morse] ?? "?";
}

export interface MorseStep {
  morse: string;
  letter: string;
  wordStart: boolean;
}

/** 把 " / " 分隔的莫尔斯串（如 ".... . .-.. .-.. --- / .-- --- .-. .-.. -.."）拆成字母步骤。 */
export function buildMorseSteps(decodedMorse: string): MorseStep[] {
  return String(decodedMorse || "")
    .split(" / ")
    .flatMap((word, wordIndex) =>
      word
        .split(/\s{2,}/)
        .filter(Boolean)
        .map((morse, characterIndex) => ({
          morse,
          letter: MORSE_TO_TEXT[morse] ?? "?",
          wordStart: wordIndex > 0 && characterIndex === 0,
        })),
    );
}

/** 事件码 -> 符号；后端约定 1=点、2=划、3=字母边界、4=单词边界。 */
export const EVENT_DOT = 1;
export const EVENT_DASH = 2;
export const EVENT_LETTER_BOUNDARY = 3;
export const EVENT_WORD_BOUNDARY = 4;
