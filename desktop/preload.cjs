// 通韵 TongYun 桌面壳：预加载脚本 —— 向页面暴露窗口控制与运行环境信息。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tongyunDesktop", {
  platform: process.platform,
  isPackaged: true,
  controls: {
    minimize: () => ipcRenderer.send("win:minimize"),
    toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
    close: () => ipcRenderer.send("win:close"),
  },
});
