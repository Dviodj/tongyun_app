# 📤 上传到 GitHub 指南（tongyun_app）

本仓库已在 GitHub 上线：<https://github.com/Dviodj/tongyun_app>

## 日常更新

```powershell
cd D:\deepseek\tongyun_app
git add -A
git commit -m "描述本次改动"
git push
```

首次在本机推送时若提示凭据：GitHub 已停用密码推送，请使用 Personal Access Token
（GitHub 网页 → Settings → Developer settings → Personal access tokens → 勾选 repo）作为密码。

## 发布新版本（桌面安装包）

```powershell
# 1. 重新构建前端与安装器
cd frontend && npm run build && cd ..
cd desktop  && npm run dist && cd ..

# 2. 创建 Release 并上传安装器（自动读取本机 GitHub 凭据）
python scripts/github-release.py release
python scripts/github-release.py assets
```

## 说明

- `backend/data/`、`desktop/release/`、`desktop/node_modules/`、`frontend/dist/` 已忽略，不入库
- 训练权重 `.pt/.pth` 不属于本仓库，按算法仓库说明单独训练与部署
- `tongyun-bci-algorithm/` 是算法包源码副本（随桌面版打包），更新算法后同步复制
