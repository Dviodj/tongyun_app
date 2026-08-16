// GDF 上传 + 回退分类器训练 UI 流程验证
import { chromium } from "playwright-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const GDF = "D:\\db\\BCICIV_2b_gdf\\B0101T.gdf";

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
page.on("pageerror", (err) => console.log("PAGE ERROR:", String(err)));

await page.goto("http://127.0.0.1:8765/#main", { waitUntil: "networkidle" });
await page.waitForTimeout(500);

console.log("上传 GDF…");
await page.locator('.source-dropzone input[type="file"]').setInputFiles(GDF);
await page.waitForFunction(
  () => document.querySelector(".source-copy strong")?.textContent?.includes("B0101T"),
  { timeout: 90000 },
);
const name = await page.locator(".source-copy strong").innerText();
console.log("已加载:", name);

const trainBtn = page.locator(".btn", { hasText: "训练 CSP+LDA 回退" });
console.log("训练按钮可见:", await trainBtn.isVisible());
await trainBtn.click();
await page.waitForFunction(
  () => {
    const notice = document.querySelector(".waveform-notice")?.textContent ?? "";
    return notice.includes("训练完成") || notice.includes("失败");
  },
  { timeout: 120000 },
);
const notice = await page.locator(".waveform-notice").innerText();
console.log("训练结果:", notice);

const health = await page.evaluate(async () => {
  const response = await fetch("/api/algorithm/health");
  return response.json();
});
console.log("health fallback:", JSON.stringify(health.fallback));

// 播放一段验证推理调用（回退模式下 predict 走 bandpower_lda）
await page.locator(".waveform-controls .btn-primary").click();
await page.waitForTimeout(8000);
const streamCells = await page.locator(".stream-cell.is-accepted, .stream-cell.is-rejected").count();
const sentence = await page.locator(".sentence-text").innerText();
console.log("已处理事件:", streamCells, "句子:", JSON.stringify(sentence.slice(0, 30)));
await page.locator(".waveform-controls .btn-primary").click();

await browser.close();
console.log("GDF 流程验证完成");
