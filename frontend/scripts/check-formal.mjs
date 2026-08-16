// 验证 ?mode=formal&live= 深链接
import { chromium } from "playwright-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
const liveCalls = [];
page.on("request", (request) => {
  if (request.url().includes("/api/live")) liveCalls.push(`${request.method()} ${request.url()}`);
});
await page.goto("http://127.0.0.1:8765/#main?mode=formal&live=HELLO%20WORLD", { waitUntil: "domcontentloaded" });
for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(1000);
  const backend = await page.evaluate(async () => {
    const response = await fetch("/api/live/status");
    return response.json();
  });
  const chip = await page.locator(".chip-live").count();
  console.log(`t=${i + 1}s backend.running=${backend.running} events=${backend.event_count} chip=${chip}`);
}
console.log("live API calls:", JSON.stringify(liveCalls, null, 2));
await browser.close();
