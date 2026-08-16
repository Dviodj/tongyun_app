# 📤 上传新仓库到 GitHub 指南

本仓库已完整打包在本地，按下面的步骤上传为一个**新的 GitHub 仓库**。

## 方式一：GitHub 网页创建（推荐，全程可视化）

1. 打开 <https://github.com/new>
2. **Repository name** 填 `tongyun-bci-web`（或你喜欢的名字）
3. **Description** 可填：`通韵 TongYun BCI 前端 — macOS 风格脑电莫尔斯码识别界面`
4. 选择 **Public**（公开）或 **Private**（私有）
5. ⚠️ **不要**勾选 “Add a README file / .gitignore / license”（本仓库已自带，勾了会导致首次推送冲突）
6. 点 **Create repository**，记下页面显示的仓库地址，例如：
   `https://github.com/Dviodj/tongyun-bci-web.git`

## 方式二：命令行创建

```powershell
# 先在本机登录 GitHub（没有 gh 的话先去 https://cli.github.com 安装）
gh auth login
gh repo create tongyun-bci-web --public --source . --push
# 完成后直接跳到「完成」——方式二会自动推送
```

## 本地推送（方式一创建完仓库后）

```powershell
cd D:\deepseek\tongyun-bci-web

git init -b main
git add .
git commit -m "feat: 通韵 TongYun BCI Web 前端 — macOS 风格脑电莫尔斯识别界面"

# 首次推送需要凭据：GitHub 已停用密码推送，
# 在浏览器生成 Personal Access Token（repo 权限）后用它当密码：
#   https://github.com/settings/tokens -> Generate new token (classic) -> 勾选 repo
git remote add origin https://github.com/<你的用户名>/tongyun-bci-web.git
git push -u origin main
```

> 💡 为避免每次输入凭据，可运行 `git config --global credential.helper manager-core`，首次输入一次后 Windows 会记住。

## 完成 ✅

推送成功后访问 `https://github.com/<你的用户名>/tongyun-bci-web` 即可看到仓库。

### 建议补充（可选）

- 在仓库 **Settings → General → Social preview** 上传一张截图（可用 `docs/screenshots/main.png`）
- 若日后想把算法仓库一并关联，可在 README 中加链接或使用 `git submodule add https://github.com/Dviodj/tongyun-bci-algorithm.git`

### 注意

- 不要提交 `backend/data/`（运行时上传缓存）与 `frontend/scripts/count_*.txt`（原始语料，已在 .gitignore 中排除）
- 训练权重 `.pt/.pth` 不属于本仓库，按算法仓库说明单独训练与部署
