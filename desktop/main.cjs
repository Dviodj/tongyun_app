// 通韵 TongYun App 桌面应用主进程
// 职责：解析资源路径 -> 启动 Python 桥接后端 -> 健康检查 -> 打开主窗口；
//       依赖缺失时提供一键安装；后端崩溃时可重试；退出时清理子进程。
"use strict";

const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");

const SMOKE = process.argv.includes("--smoke-test");
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");

const BACKEND_PY = path.join(ROOT, "backend", "backend.py");
const STATIC_DIR = path.join(ROOT, "frontend", "dist");
const ALGO_REPO = path.join(ROOT, "tongyun-bci-algorithm");
const REQUIREMENTS = path.join(ROOT, "requirements-backend.txt");

let splash = null;
let mainWindow = null;
let backendProcess = null;
let backendPort = null;
let quitting = false;
let smokeDone = false;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function findPythonCandidates() {
  const candidates = [];
  if (process.env.TONGYUN_PYTHON) candidates.push(process.env.TONGYUN_PYTHON);
  if (process.platform === "win32") {
    candidates.push("py", "py -3", "python", "python3");
  } else {
    candidates.push("python3", "python");
  }
  return candidates;
}

function resolvePython() {
  return new Promise((resolve) => {
    const candidates = findPythonCandidates();
    const tryNext = (index) => {
      if (index >= candidates.length) return resolve(null);
      const candidate = candidates[index];
      const parts = candidate.split(" ");
      const command = parts[0];
      const args = parts.slice(1).concat(["-c", "import sys; print(sys.executable)"]);
      execFile(command, args, { timeout: 15000, windowsHide: true }, (error, stdout) => {
        if (!error && stdout && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          tryNext(index + 1);
        }
      });
    };
    tryNext(0);
  });
}

function checkBackendDeps(pythonPath) {
  return new Promise((resolve) => {
    execFile(
      pythonPath,
      ["-c", "import numpy, scipy, sklearn; print('ok')"],
      { timeout: 30000, windowsHide: true },
      (error, stdout) => resolve(!error && String(stdout).includes("ok")),
    );
  });
}

function healthRequest(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/api/algorithm/health", timeout: 3000 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

function logPath() {
  return path.join(app.getPath("userData"), "backend.log");
}

// ---------------------------------------------------------------------------
// 后端生命周期
// ---------------------------------------------------------------------------

async function startBackend() {
  stopBackend(); // 重试前清理可能残留的旧进程
  const pythonPath = await resolvePython();
  if (!pythonPath) {
    splashError(
      "未找到 Python 环境",
      "请安装 Python 3.9+ 并勾选「Add to PATH」，或设置环境变量 TONGYUN_PYTHON 指向 python.exe。",
      { canRetry: true, canInstall: false },
    );
    return;
  }

  const depsOk = await checkBackendDeps(pythonPath);
  if (!depsOk) {
    splashError(
      "缺少后端依赖",
      "需要 numpy / scipy / scikit-learn（解析脑电文件与回退分类）。点击「安装依赖」自动执行 pip install。",
      { canRetry: true, canInstall: true, pythonPath },
    );
    return;
  }

  if (!fs.existsSync(BACKEND_PY)) {
    splashError("后端脚本缺失", `未找到 ${BACKEND_PY}`, { canRetry: false, canInstall: false });
    return;
  }
  if (!fs.existsSync(path.join(STATIC_DIR, "index.html"))) {
    splashError(
      "前端未构建",
      `未找到 ${STATIC_DIR}\\index.html。请在 frontend 目录运行 npm install && npm run build。`,
      { canRetry: false, canInstall: false },
    );
    return;
  }

  const port = await pickFreePort();
  backendPort = port;
  const uploadsDir = path.join(app.getPath("userData"), "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const args = [
    BACKEND_PY,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--repo", ALGO_REPO,
    "--static", STATIC_DIR,
    "--uploads", uploadsDir,
  ];
  splashStatus(`正在启动算法服务（端口 ${port}）…`);

  const logStream = fs.createWriteStream(logPath(), { flags: "a" });
  backendProcess = spawn(pythonPath, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  backendProcess.stdout.pipe(logStream);
  backendProcess.stderr.pipe(logStream);

  let exitNotified = false;
  backendProcess.on("exit", (code) => {
    if (quitting || exitNotified) return;
    exitNotified = true;
    const tail = readLogTail();
    if (!mainWindow) {
      splashError(
        "算法服务启动失败",
        `Python 后端异常退出（code ${code}）。${tail ? `\n\n${tail}` : ""}`,
        { canRetry: true, canInstall: false, pythonPath },
      );
    } else {
      dialog
        .showMessageBox(mainWindow, {
          type: "error",
          title: "算法服务已停止",
          message: "Python 后端异常退出。",
          detail: tail || `退出码 ${code}`,
          buttons: ["重试", "退出"],
        })
        .then(({ response }) => {
          if (response === 0) startBackend();
          else app.quit();
        });
    }
  });

  // 健康轮询
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500);
    if (quitting) return;
    if (await healthRequest(port)) {
      onBackendReady();
      return;
    }
  }
  splashError(
    "算法服务超时",
    `健康检查超时（端口 ${port}）。${readLogTail() || ""}`,
    { canRetry: true, canInstall: false, pythonPath },
  );
}

function readLogTail() {
  try {
    const content = fs.readFileSync(logPath(), "utf8");
    return content.split("\n").slice(-12).join("\n");
  } catch {
    return "";
  }
}

function onBackendReady() {
  splashStatus("算法服务已就绪，正在打开主窗口…");
  if (mainWindow) {
    // 崩溃重试：复用窗口，重新加载新端口
    mainWindow.loadURL(`http://127.0.0.1:${backendPort}/#main`);
    return;
  }
  createMainWindow();
}

function stopBackend() {
  if (backendProcess) {
    try {
      backendProcess.kill();
    } catch {
      /* 忽略 */
    }
    backendProcess = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installDependencies(pythonPath) {
  splashStatus("正在安装后端依赖（pip install -r requirements-backend.txt）…");
  const child = execFile(
    pythonPath,
    ["-m", "pip", "install", "-r", REQUIREMENTS],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 16 },
    (error) => {
      if (quitting) return;
      if (error) {
        splashError("依赖安装失败", String(error).slice(0, 800), {
          canRetry: true,
          canInstall: true,
          pythonPath,
        });
      } else {
        splashStatus("依赖安装完成，正在重启服务…");
        startBackend();
      }
    },
  );
  if (child.stdout) child.stdout.on("data", (chunk) => splashStatus(String(chunk).trim().slice(-120)));
  if (child.stderr) child.stderr.on("data", (chunk) => splashStatus(String(chunk).trim().slice(-120)));
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createSplash() {
  splash = new BrowserWindow({
    width: 430,
    height: 310,
    resizable: false,
    frame: false,
    transparent: false,
    show: SMOKE ? false : true,
    backgroundColor: "#1e1e20",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(splashHtml()));
  splash.on("closed", () => {
    splash = null;
  });
}

function splashHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: "Segoe UI Variable", "Microsoft YaHei", sans-serif;
           background:#1e1e20; color:#f5f5f7; display:flex; flex-direction:column; height:100vh;
           -webkit-user-select:none; user-select:none; }
    .head { display:flex; align-items:center; gap:10px; padding:20px 22px 4px; }
    .badge { width:40px; height:40px; border-radius:10px; background:linear-gradient(145deg,#0a84ff,#7a2fff);
             display:grid; place-items:center; font-weight:800; font-size:20px; color:#fff; }
    .title { font-size:15px; font-weight:700; } .sub { font-size:11px; color:#98989d; }
    .status { flex:1; display:flex; align-items:center; justify-content:center; padding:0 22px;
              font-size:13px; color:#a1a1a6; text-align:center; line-height:1.6; word-break:break-all; }
    .status.error { color:#ff8a80; }
    .actions { display:flex; gap:8px; padding:0 22px 22px; justify-content:center; flex-wrap:wrap; }
    button { border:none; border-radius:8px; padding:8px 16px; font-size:13px; font-weight:600; cursor:pointer;
             font-family:inherit; }
    .primary { background:#0a84ff; color:#fff; } .quiet { background:#3a3a3c; color:#f5f5f7; }
    .spin { display:inline-block; width:12px; height:12px; border-radius:50%;
            border:2px solid #48484a; border-top-color:#0a84ff; animation:s .8s linear infinite; margin-right:8px;
            vertical-align:-1px; }
    @keyframes s { to { transform: rotate(360deg); } }
    .error-box { margin:0 22px; padding:10px 12px; background:#2c1f1f; border:1px solid #5a3030; border-radius:8px;
                 font:11px/1.5 Consolas, monospace; color:#ff9e9e; white-space:pre-wrap; max-height:110px; overflow:auto; }
  </style></head><body>
    <div class="head"><div class="badge">通</div><div><div class="title">通韵 TongYun</div>
    <div class="sub">脑电 · 莫尔斯码输入系统</div></div></div>
    <div class="status" id="status"><span class="spin"></span>正在初始化…</div>
    <div class="error-box" id="errorbox" style="display:none"></div>
    <div class="actions" id="actions" style="display:none"></div>
    <script>
      window.setStatus = (text, isError) => {
        document.getElementById("status").textContent = text;
        document.getElementById("status").className = "status" + (isError ? " error" : "");
      };
      window.setErrorBox = (text) => {
        const box = document.getElementById("errorbox");
        box.style.display = text ? "block" : "none";
        box.textContent = text;
      };
    </script>
  </body></html>`;
}

function splashStatus(text, isError = false) {
  if (!splash) return;
  splash.webContents.executeJavaScript(`window.setStatus(${JSON.stringify(text)}, ${isError})`).catch(() => {});
}

function splashError(title, detail, options = {}) {
  if (!splash) return;
  if (options.pythonPath) pendingPythonPath = options.pythonPath;
  splash.setSize(430, 460);
  splash.webContents.executeJavaScript(`
    window.setStatus(${JSON.stringify(title)}, true);
    window.setErrorBox(${JSON.stringify(detail || "")});
    const actions = document.getElementById("actions");
    actions.style.display = "flex";
    actions.innerHTML = "";
    const add = (label, primary) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.className = primary ? "primary" : "quiet";
      actions.appendChild(btn);
      return btn;
    };
    ${options.canRetry ? `add("重试", true).onclick = () => window.__act("retry");` : ""}
    ${options.canInstall ? `add("安装依赖", true).onclick = () => window.__act("install");` : ""}
    add("打开日志").onclick = () => window.__act("log");
    add("退出").onclick = () => window.__act("quit");
    window.__act = (action) => { window.__pendingAction = action; };
  `).catch(() => {});
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    // 冒烟模式也显示窗口：隐藏窗口下 capturePage 只拍到背景色
    show: true,
    backgroundColor: "#eef0f3",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const demoQuery = SMOKE ? "?demo=HELLO%20WORLD&speed=2" : "";
  mainWindow.loadURL(`http://127.0.0.1:${backendPort}/#main${demoQuery}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (SMOKE) {
    mainWindow.webContents.once("did-finish-load", async () => {
      await sleep(9000);
      try {
        const image = await mainWindow.webContents.capturePage();
        const target = path.join(app.getPath("userData"), "smoke.png");
        fs.writeFileSync(target, image.toPNG());
        console.log(`SMOKE OK: ${target} (${image.toPNG().length} bytes)`);
      } catch (error) {
        console.error("SMOKE CAPTURE FAILED:", error);
      }
      smokeDone = true;
      app.quit();
    });
  }

  if (splash) splash.close();
}

let pendingPythonPath = null;

// 启动页按钮：splash 无 preload，通过轮询 window.__pendingAction 接收动作
function bindSplashActions() {
  setInterval(() => {
    if (!splash) return;
    splash.webContents
      .executeJavaScript(
        "window.__pendingAction ? (() => { const a = window.__pendingAction; window.__pendingAction = null; return a; })() : null",
      )
      .then((action) => {
        if (!action) return;
        if (action === "retry") startBackend();
        if (action === "install") startBackendInstallFallback();
        if (action === "log") shell.openPath(logPath());
        if (action === "quit") app.quit();
      })
      .catch(() => {});
  }, 400);
}

function startBackendInstallFallback() {
  if (pendingPythonPath) installDependencies(pendingPythonPath);
  else splashStatus("无法确定 Python 环境，请先安装 Python", true);
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "退出", accelerator: "Alt+F4", click: () => app.quit() },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载", accelerator: "F5", click: () => mainWindow?.reload() },
        { label: "开发者工具", accelerator: "Ctrl+Shift+I", click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 通韵 TongYun",
          click: () =>
            dialog.showMessageBox({
              type: "info",
              title: "关于",
              message: "通韵 TongYun App",
              detail: `脑电 · 莫尔斯码输入系统\n后端：${BACKEND_PY}\n数据目录：${app.getPath("userData")}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    createSplash();
    splashStatus("正在检查运行环境…");
    bindSplashActions();
    await startBackend();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopBackend();
  });
}
