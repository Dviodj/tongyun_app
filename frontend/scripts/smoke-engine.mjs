// 预测引擎冒烟测试（esbuild 打包后运行）
import { completeWord, nextWord, nextLetter, predictSentences, suggestCorrections } from "./engine.mjs";

const show = (label, list) => console.log(label, list.map((x) => `${x.value}:${(x.probability * 100).toFixed(1)}%`).join("  "));

show("completeWord('hel')      ", completeWord("hel", 5));
show("nextWord(['i','want'])   ", nextWord(["I", "WANT"], 5));
show("nextLetter('.-','')      ", nextLetter(".-", "", 6));
show("nextLetter('','hel')     ", nextLetter("", "hel", 6));
show("predictSentences('HELLO')", predictSentences("HELLO", 5));
show("predictSentences('I WANT TO')", predictSentences("I WANT TO", 5));
console.log("corrections('BELLO WORLD')", JSON.stringify(suggestCorrections("BELLO WORLD", 3)));
console.log("corrections('HELLO WORLD')", JSON.stringify(suggestCorrections("HELLO WORLD", 3)));
