// 端到端验证：用系统 Edge + playwright-core 驱动页面，断言关键交互。
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = "http://127.0.0.1:8765/";
const FIF = "D:\\deepseek\\tongyun_app\\sample-data\\hello-world\\02_error_h_to_b_dot_to_dash_raw.fif";

const results = [];
const consoleErrors = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(String(err)));

// ---- 1. 主页面渲染 ----
await page.goto(BASE + "#main", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
check("顶部应用栏渲染", (await page.locator(".app-header").count()) === 1);
check("底部状态栏渲染", (await page.locator(".statusbar").count()) === 1);
check("已移除交通灯", (await page.locator(".traffic-lights").count()) === 0);
check("侧栏三个导航项", (await page.locator(".nav-item").count()) === 3);
check("句子小组件存在", await page.locator(".sentence-card").isVisible());
check("莫尔斯小组件存在", await page.locator(".morse-card").isVisible());
check("波形小组件存在", await page.locator(".waveform-card").isVisible());
check("单词预测小组件存在（唯一）", (await page.locator(".prediction-widget").count()) === 1);
check("主页面无大标题", (await page.locator(".main-view .section-header").count()) === 0);
check("确定/取消/暂停按钮存在", (await page.locator(".action-confirm").count() + await page.locator(".action-cancel").count() + await page.locator(".action-pause").count()) === 3);

// 无横向溢出
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check("无横向溢出", overflow <= 0, `scrollWidth 超出 ${overflow}px`);

// ---- 2. 手动输入点划 ----
await page.locator(".manual-input .btn", { hasText: "点" }).click();
await page.locator(".manual-input .btn", { hasText: "划" }).click();
const dots = await page.locator(".morse-group-symbols .large-dot").count();
const dashes = await page.locator(".morse-group-symbols .large-dash").count();
check("手动点划进入当前组", dots === 1 && dashes === 1, `dot=${dots} dash=${dashes}`);
await page.keyboard.press("Enter");
const sentenceAfter = await page.locator(".sentence-text").innerText();
check("确定键写入字母 A", sentenceAfter.includes("A"), sentenceAfter);
await page.keyboard.press("Backspace");
const afterBackspace = await page.locator(".sentence-text").innerText();
check("取消键撤销字符", !afterBackspace.includes("A"), afterBackspace);

// ---- 3. 键盘点划 + 单词预测 ----
await page.keyboard.type(".");
await page.keyboard.type("-");
const wordCount = await page.locator(".prediction-word-main").count();
const wordText = wordCount ? await page.locator(".prediction-word-main b").innerText() : "";
check("单词预测唯一且非空", wordCount === 1 && wordText.trim().length > 0, `count=${wordCount} word=${wordText}`);
// 点击采用预测单词
if (wordCount) {
  await page.locator(".prediction-word-main").click();
  await page.waitForTimeout(200);
  const afterAdopt = await page.locator(".sentence-text").innerText();
  check("点击采用预测单词写入句子", afterAdopt.includes(wordText), afterAdopt);
}

// ---- 3.5 模式切换 + 设备接入 ----
const modePill = page.locator(".mode-pill");
check("模式切换按钮存在", (await modePill.count()) === 1);
check("默认模拟模式", (await modePill.innerText()).includes("模拟模式"));
check("大脑图标已移除", (await page.locator(".brand-badge svg").count()) === 0);
await modePill.click();
await page.waitForTimeout(300);
check("点击切换到正式模式", (await modePill.innerText()).includes("正式模式"));
check("正式模式显示设备面板", await page.locator(".device-widget").isVisible());
check("正式模式隐藏模拟生成行", (await page.locator(".sim-row").count()) === 0);
// 连接内置模拟设备
await page.locator(".device-widget .btn-primary", { hasText: "连接并开始" }).click();
await page.waitForTimeout(3500);
const liveCells = await page.locator(".stream-cell.is-accepted").count();
check("实时解码事件流入点划流", liveCells > 0, `cells=${liveCells}`);
check("实时解码状态芯片显示", (await page.locator(".chip-live").count()) === 1);
const liveDecoded = await page.locator(".chip-live").innerText();
check("实时解码文本推进", /解码中/.test(liveDecoded) && /事件/.test(liveDecoded), liveDecoded);
// 停止
await page.locator(".device-widget .btn", { hasText: "停止解码" }).click();
await page.waitForTimeout(400);
check("停止实时解码", (await page.locator(".chip-live").count()) === 0);
// LSL 扫描（无流时安全提示）
await page.locator(".device-widget .segmented-option", { hasText: "LSL 设备" }).click();
await page.waitForTimeout(200);
await page.locator(".device-widget .btn", { hasText: "扫描设备流" }).click();
await page.waitForTimeout(3000);
const lslArea = await page.locator(".device-widget").innerText();
check("LSL 扫描安全返回", lslArea.length > 0, "no crash");
// 切回模拟模式
await page.locator(".device-widget .segmented-option", { hasText: "模拟设备" }).click();
await page.waitForTimeout(200);
await modePill.click();
await page.waitForTimeout(300);
check("切回模拟模式", (await modePill.innerText()).includes("模拟模式"));
check("模拟生成行恢复", (await page.locator(".sim-row").count()) === 1);

// ---- 4. 设置页 ----
await page.goto(BASE + "#settings", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
check("设置页主题切换存在", await page.locator(".segmented-option", { hasText: "深色" }).count() >= 1);
await page.locator(".segmented-option", { hasText: "深色" }).first().click();
await page.waitForTimeout(200);
const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
check("深色主题生效", themeAfter === "dark", themeAfter);
await page.locator(".segmented-option", { hasText: "浅色" }).first().click();
await page.waitForTimeout(200);
check("浅色主题还原", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
await page.locator(".accent-swatch").nth(3).click(); // 红色
const accentAfter = await page.evaluate(() => document.documentElement.style.getPropertyValue("--accent").trim());
check("强调色切换生效", accentAfter === "#ff453a", accentAfter);
// 隐藏板块
await page.locator(".panel-toggle-row", { hasText: "下个单词预测" }).locator(".toggle").click();
await page.waitForTimeout(200);
await page.goto(BASE + "#main", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
check("板块隐藏生效（单词预测消失）", (await page.locator(".prediction-widget").count()) === 0);
// 还原
await page.goto(BASE + "#settings", { waitUntil: "networkidle" });
await page.waitForTimeout(400);
await page.locator(".panel-toggle-row", { hasText: "下个单词预测" }).locator(".toggle").click();
await page.waitForTimeout(200);
await page.locator(".accent-swatch").first().click();

// ---- 5. 时间窗页拖动 ----
await page.goto(BASE + "#window", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
check("时间窗画布存在", await page.locator(".window-canvas").isVisible());
const box = await page.locator(".window-canvas").boundingBox();
// 向右拖动右边缘（tmax 增大）
const xRight = box.x + ((4.0 - -1) / 6) * box.width; // t=4.0 处
await page.mouse.move(xRight, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(xRight + 60, box.y + box.height / 2, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
const tmaxAfter = Number(await page.locator(".window-field input").nth(1).inputValue());
check("拖动右边缘改变 tmax", tmaxAfter > 4.05, `tmax=${tmaxAfter}`);
// 拖动中间整体平移
const xMid = box.x + ((2.2 - -1) / 6) * box.width;
await page.mouse.move(xMid, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(xMid + 40, box.y + box.height / 2, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(200);
const tminAfterMove = Number(await page.locator(".window-field input").first().inputValue());
check("拖动中间平移窗口", tminAfterMove > 0.5, `tmin=${tminAfterMove}`);
await page.locator(".btn-primary", { hasText: "应用窗口" }).click();
await page.waitForTimeout(600);
const applied = await page.locator(".btn-primary").innerText();
check("应用窗口成功", applied.includes("已应用"), applied);

// ---- 6. 上传 FIF 并回放 ----
await page.goto(BASE + "#main", { waitUntil: "networkidle" });
await page.waitForTimeout(400);
await page.locator('.source-dropzone input[type="file"]').setInputFiles(FIF);
await page.waitForTimeout(4000);
const sourceName = await page.locator(".source-copy strong").innerText();
check("FIF 上传成功显示文件名", sourceName.includes("02_error_h_to_b"), sourceName);
check("波形画布有数据", await page.evaluate(() => {
  const canvas = document.querySelector(".waveform-canvas");
  return canvas && canvas.width > 0 && canvas.height > 0;
}));
// 播放（2× 速度缩短时间）
await page.locator(".segmented-option", { hasText: "2×" }).click();
await page.locator(".waveform-controls .btn-primary").click();
await page.waitForTimeout(3000);
const playing = await page.locator(".action-pause").innerText();
check("播放状态生效", playing.includes("暂停") || playing.includes("继续"), playing);
// 等解码完成（BELLO WORLD 约 30s@1x → 2x 15s）
await page.waitForFunction(
  () => document.querySelector(".sentence-text")?.textContent?.includes("BELLO WORLD"),
  { timeout: 30000 },
).catch(() => {});
const finalText = await page.locator(".sentence-text").innerText();
check("回放解码出 BELLO WORLD", finalText.includes("BELLO WORLD"), finalText);
check("纠错建议出现", await page.locator(".correction-item").count() >= 1);
if (await page.locator(".correction-item .btn", { hasText: "接受" }).first().count()) {
  await page.locator(".correction-item .btn", { hasText: "接受" }).first().click();
  await page.waitForTimeout(400);
  const corrected = await page.locator(".sentence-text").innerText();
  check("接受纠错后变为 HELLO WORLD", corrected.includes("HELLO WORLD"), corrected);
}

// ---- 7. 模拟源 ----
await page.locator(".btn", { hasText: "生成模拟脑电" }).click();
await page.waitForTimeout(2500);
const simName = await page.locator(".source-copy strong").innerText();
check("模拟源生成成功", simName.includes("模拟源"), simName);

// ---- 汇总 ----
const failed = results.filter((r) => !r.ok);
console.log(`\n===== 共 ${results.length} 项，失败 ${failed.length} 项 =====`);
if (consoleErrors.length) {
  console.log("控制台错误：");
  for (const err of consoleErrors.slice(0, 10)) console.log("  ", err);
}
await browser.close();
process.exit(failed.length ? 1 : 0);
