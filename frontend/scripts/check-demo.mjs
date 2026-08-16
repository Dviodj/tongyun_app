// 验证 demo/theme URL 参数生效
import { chromium } from "playwright-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath: EDGE, headless: true });

const light = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
await light.goto("http://127.0.0.1:8765/#main?demo=HELLO%20WORLD&speed=2", { waitUntil: "networkidle" });
await light.waitForTimeout(6000);
console.log("light demo text:", JSON.stringify((await light.locator(".sentence-text").innerText()).slice(0, 40)),
  "theme:", await light.evaluate(() => document.documentElement.dataset.theme));
await light.close();

const dark = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
await dark.goto("http://127.0.0.1:8765/#main?demo=HELLO%20WORLD&speed=2&theme=dark", { waitUntil: "networkidle" });
await dark.waitForTimeout(6000);
console.log("dark demo text:", JSON.stringify((await dark.locator(".sentence-text").innerText()).slice(0, 40)),
  "theme:", await dark.evaluate(() => document.documentElement.dataset.theme));
await dark.close();

await browser.close();
