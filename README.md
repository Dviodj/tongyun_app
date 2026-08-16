# 通韵 TongYun BCI Web

🧠 基于 **tongyun--bci** 与 **tongyun-bci-algorithm** 的脑电-莫尔斯码识别软件前端：macOS 风格的三栏式界面，左侧控制栏（主页面 / 时间窗调整 / 设置），右侧显示区域。

![主页](docs/screenshots/main.png)

## ✨ 功能

### 双模式（标题栏状态可点击切换）

- **模拟模式**：开箱即用的演示体验——生成模拟脑电回放、`?demo=HELLO WORLD` 一键演示
- **正式模式**：真实解码工作台——
  - **脑电文件**：拖入 GDF/EDF/FIF/JSON/NPY 解析解码（与模拟模式共享波形回放）
  - **实时解码 · 设备接入**：连接 **LSL 设备流**（Lab Streaming Layer，研究级脑电设备通用协议）实时滑动窗解码；无硬件时可连接**内置模拟设备**体验完整链路；UI 随模式切换（模拟行隐藏、设备面板/实时波形出现）

### 主页面（桌面小组件式拼接，无大标题）
- **识别句子**（主显示区）：脑电信号解码出的句子实时呈现，AI 建议从不静默覆盖原文，纠错必须人工点「接受」
- **下个单词预测**：只给出**最可能的那一个**单词（离线 n-gram 语言模型，纯前端推理），点击即可采用
- **确定 / 取消 / 暂停**：确认当前字母、撤销、暂停回放（支持键盘：`.` `←` 点、`-` `→` 划、`Enter` 确定、`Backspace` 撤销）
- **识别莫尔斯码**：点划流 + 当前字母 + 手动输入（含空格键），与**波形**（C3/Cz/C4 三通道 Canvas、事件标记、播放头、0.5×/1×/2× 回放、拖拽上传）无缝拼接；实时解码时波形显示滚动缓冲 + 当前解码窗口着色

### 时间窗调整
- 对应算法仓库的 0.5–4.0 s epoch 约定（100 Hz 下 351 采样点）
- 拖动两侧手柄调整起止、拖动中间平移整窗、数值输入、常用预设
- 应用后作用于新解析的 GDF/EDF/FIF；送入模型前统一重采样回 3×351，保持与训练分布一致

### 设置
- 主题：浅色 / 深色 / 跟随系统，8 种 macOS 强调色
- 布局：下半区上下堆叠 / 左右并排
- 板块显隐：识别句子、单词预测、莫尔斯码、波形图均可独立开关
- 置信门控阈值（0.5–0.95）实时应用到算法桥接服务

## 🏗 架构

```
浏览器前端 (React 19 + Vite + TypeScript + Canvas)
        │  /api/*
        ▼
backend/backend.py (纯标准库 HTTP 桥接服务)
        │
        ├─ 1) Hybrid FBC-MIFormer（tongyun-bci-algorithm 仓库，需部署权重 .pt）
        ├─ 2) 回退：频带能量 + LDA（无权重时，用带 769/770 标签的 GDF 一键训练，B0101T 实测 85.8%）
        ├─ 3) 事件流 FIF/EDF：文件自带 1=点 2=划 3=字母边界 4=单词边界 事件码，直接解码
        └─ 4) 模拟模式：无任何数据时合成脑电（含低置信拒识演示），开箱可用
```

三级降级保证任何环境下界面都能完整演示；拿到部署权重后无需改代码，`model_loaded` 自动切换。

## 🚀 快速开始

### 方式 A：桌面软件（推荐）

构建好的安装器安装后即可使用（Electron 壳 + 自动拉起 Python 后端）：

```powershell
# 打包桌面版（生成安装器与便携版到 desktop/release/）
cd frontend && npm install && npm run build && cd ..
cd desktop  && npm install && npm run dist

# 开发时直接运行桌面版
双击「启动桌面版.bat」  或  cd desktop && npm start
```

桌面版特性：
- 无边框 macOS 风格窗口，红黄绿交通灯可点击（关闭/最小化/最大化）
- 启动时自动检测 Python 与后端依赖（numpy/scipy/scikit-learn），缺失时一键 `pip install`
- 后端作为子进程随应用启停，崩溃自动提示重试；算法仓库（深度学习版）源码随安装包分发
- 首次运行需要本机 Python 3.9+（解析 GDF/EDF/FIF 与加载权重另需 mne / torch，按提示安装）

> 💡 国内网络下载 Electron 二进制较慢时，打包前设置镜像：
> `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`
> `$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`
> 若 npm 拦截了 postinstall 脚本，先执行 `npm approve-scripts electron electron-winstaller` 再 `npm install`。

### 方式 B：浏览器运行

### 环境

- Python ≥ 3.9：`pip install numpy scipy scikit-learn`（解析 GDF/EDF/FIF 另需 `pip install mne`，加载权重另需 `torch`）
- Node.js ≥ 20 + npm（仅构建前端需要；仓库已含构建产物时不需要）

### 启动

```powershell
# 1. 构建前端（首次）
cd frontend
npm install
npm run build
cd ..

# 2. 启动桥接服务（同时提供页面与算法 API）
python backend\backend.py --repo ..\tongyun-bci-algorithm
#    （若算法仓库装在别处：--repo <路径>；若有部署权重：--model <路径> 或设置 TONGYUN_MODEL_PATH）

# 3. 打开浏览器
#    http://127.0.0.1:8765/
```

Windows 下也可以直接双击 `启动服务.bat`。

**无数据快速体验**：打开 `http://127.0.0.1:8765/#main?demo=HELLO WORLD` 自动生成模拟脑电并回放；
或在波形面板输入文本点「生成模拟脑电」，再点「播放」。

**真实数据**：拖入 `sample-data/hello-world/*.fif`（事件流，可直接解码），
或 `D:\db\BCICIV_2b_gdf\B0101T.gdf`（运动想象 epochs，上传后点「训练 CSP+LDA 回退」获得真实推理）。

### 开发模式

```powershell
cd frontend
npm run dev          # Vite 热更新，/api 自动代理到 127.0.0.1:8765
```

## 🔌 算法接入

- 接口契约沿用 `ALGORITHM_INTEGRATION.md` 约定：`POST /api/algorithm/predict`，epoch 为 `3×351`（C3/Cz/C4，100 Hz，0.5–4.0 s 窗口），返回点/划 + 置信度，低于 0.68 拒绝
- 权重加载顺序：`tongyun_bci_algorithm.HybridFBCMIFormerWrapper`（深度学习版，首选）→ `models.eeg_transformer.EEGConformerWrapper`（旧分支兼容）→ 频带能量+LDA 回退（需训练）→ 模拟模式
- 权重自动搜索：`TONGYUN_MODEL_PATH` 环境变量、`backend/models/`、项目根 `models/`、算法仓库 `models/` 下的 `.pt/.pth`
- 可用 `python backend/tools/make_dummy_checkpoint.py` 生成随机权重检查点，验证深度学习加载链路（`model_loaded: true` + `predict` 通路）；随机权重无解码能力，仅用于链路自检
- 回退分类器特征选择有据可查：`backend/tools/debug_features.py`（均值/标准差 + μ/β 频带能量 + C3/C4 不对称性 → LDA）

### 实时解码接口（正式模式）

| 端点 | 说明 |
|---|---|
| `POST /api/live/start` | 连接设备：`{"source":"mock","text":"HELLO WORLD"}` 或 `{"source":"lsl","lsl_name":"可选"}` |
| `POST /api/live/stop` | 停止实时解码 |
| `GET /api/live/status` | 运行状态、事件数、已解码文本 |
| `GET /api/live/events?after=N` | 增量拉取解码事件（1=点 2=划 3=字母边界 4=单词边界 0=拒识） |
| `GET /api/live/waveform` | 滚动波形缓冲（三通道 + 事件标记） |
| `GET /api/live/lsl/streams` | 扫描可用的 LSL 设备流 |

LSL 设备流按 3.5 s 滑动窗口切分（采样率自适应），优先匹配 C3/Cz/C4 通道，送入当前算法（深度学习权重 > 回退分类器）；内置模拟设备无需任何硬件与模型即可完整演示。需 `pip install pylsl`。

## 🧠 预测模块

`frontend/src/lib/predictor/`：n-gram 语言模型，数据来自公开语料（见下），构建产物已入库，开箱即用。
前端只展示「最可能的下一个单词」单个候选；完整的字母/句子预测与纠错 API 保留在引擎中（`engine.ts`）供后续扩展。

| 文件 | 说明 |
|---|---|
| `engine.ts` | 单词/字母/句子预测 + 拼写纠错（编辑距离 ≤2） |
| `data/words.ts` | 30,000 高频词 + 词频（Norvig count_1w） |
| `data/bigrams.ts` | 40,000 二元组（Norvig count_2w） |
| `templates.ts` | 60+ 常用沟通语句模板 |

重新生成：`npm run gen:lm`（需先下载语料，见 `scripts/build-lm-data.mjs` 头注释）。
引擎冒烟测试：`node scripts/smoke-engine.mjs`；端到端验证：`node scripts/e2e-verify.mjs`（需系统 Edge 与 `playwright-core`）。

## 🧪 测试

- 后端接口：`GET /api/algorithm/health`、`POST /api/simulation/start`、`POST /api/data/upload` 等（详见 `backend/backend.py` 头部注释）
- E2E（29 项断言）：渲染、手动/键盘输入、确定取消、三层预测、主题/强调色/板块开关、时间窗拖动与平移、FIF 上传回放解码「BELLO WORLD」、纠错接受为「HELLO WORLD」、模拟源生成
- hello world 10 个 FIF 的原始解码与纠错建议与 `HELLOWORLD_TEST_REPORT.md` 结论一致

## 📁 目录结构

```
tongyun-bci-web/
├── backend/
│   ├── backend.py            # 桥接服务（页面 + 算法 API）
│   └── tools/debug_features.py  # 回退分类器特征选择实验
├── frontend/
│   ├── src/
│   │   ├── components/       # 标题栏/侧栏/主页面/时间窗/设置/波形 Canvas
│   │   ├── lib/predictor/    # n-gram 语言模型
│   │   ├── state/store.ts    # zustand 全局状态
│   │   └── styles.css        # macOS 设计系统（明暗双主题）
│   └── scripts/              # 语料构建、冒烟测试、E2E
├── desktop/                  # Electron 桌面壳（安装器/便携版打包）
│   ├── main.cjs / preload.cjs / icon.png
│   └── scripts/make-icon.mjs # 图标生成器（纯 Node PNG 编码）
├── sample-data/hello-world/  # 事件流演示数据（10 个 FIF + manifest）
├── docs/screenshots/         # 界面截图
└── 启动服务.bat / 启动桌面版.bat
```

## 📄 数据与代码来源

- 语言模型语料：[Norvig n-grams](https://norvig.com/ngrams/)（count_1w / count_2w，CC-BY-NC 4.0）、[google-10000-english](https://github.com/first20hours/google-10000-english)（备用词表）
- 算法模型与评估：<https://github.com/Dviodj/tongyun-bci-algorithm>（Hybrid FBC-MIFormer）
- 事件流测试数据与纠错基线：tongyun--bci 的 `test_helloworld`（见 `sample-data/hello-world/README.md`）

## 📤 上传到 GitHub

见 [UPLOAD_GUIDE.md](UPLOAD_GUIDE.md)。

## 📄 许可

MIT License（见 LICENSE）。语言模型语料部分遵循 Norvig 语料的 CC-BY-NC 4.0。
