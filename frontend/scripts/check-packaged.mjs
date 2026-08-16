// 检查打包资源服务的页面渲染与截图大小
import { chromium } from "playwright-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(String(err)));
await page.goto("http://127.0.0.1:8877/#main?demo=HELLO%20WORLD&speed=2", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
const shot = await page.screenshot({ fullPage: false });
console.log("screenshot bytes:", shot.length);
console.log("console errors:", errors.length ? errors.slice(0, 5) : "none");
const header = await page.locator(".app-header").count();
const statusbar = await page.locator(".statusbar").count();
const sentence = await page.locator(".sentence-text").innerText();
console.log("header:", header, "statusbar:", statusbar, "sentence:", JSON.stringify(sentence.slice(0, 30)));
await browser.close();
