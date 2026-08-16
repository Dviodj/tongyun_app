"""GitHub Release 创建与资产上传（读取 Windows 凭据管理器中的 token）。"""
import json
import subprocess
import sys
import urllib.request

REPO = "Dviodj/tongyun-bci-web"
API = "https://api.github.com"


def get_token() -> str:
    output = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n",
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    for line in output.splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    raise RuntimeError("未找到 GitHub 凭据")


def api_request(url, method="GET", payload=None, content_type="application/json", timeout=1800):
    data = None
    headers = {
        "Authorization": f"Bearer {get_token()}",
        "User-Agent": "dsh-agent",
        "Accept": "application/vnd.github+json",
    }
    if payload is not None:
        if isinstance(payload, (bytes, bytearray)):
            data = bytes(payload)
            headers["Content-Type"] = content_type
        else:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "release"
    if mode == "release":
        payload = {
            "tag_name": "v1.0.0",
            "name": "通韵 TongYun 1.0.0",
            "body": (
                "首个桌面软件版本。\n\n## 内容\n"
                "- Windows 桌面应用（Electron，无边框 macOS 风格窗口，交通灯可点击）\n"
                "- 模拟 / 正式双模式：正式模式支持脑电文件解码与 LSL 设备实时解码\n"
                "- Hybrid FBC-MIFormer 深度学习算法（权重自备，见算法仓库）+ 频带能量 LDA 回退 + 模拟模式\n"
                "- 单词预测（最可能的一个）、莫尔斯码、三通道波形、可拖动时间窗、明暗主题与板块显隐\n\n"
                "## 使用\n"
                "1. 安装器安装，或直接运行便携版 exe\n"
                "2. 首次运行需要本机 Python 3.9+（numpy/scipy/scikit-learn，启动界面可一键安装）\n"
                "3. 解析 GDF/EDF/FIF 另需 mne，加载权重另需 torch，实时设备接入需 pylsl\n\n"
                "源码与构建说明见仓库 README。"
            ),
            "draft": False,
        }
        release = api_request(f"{API}/repos/{REPO}/releases", "POST", payload)
        print(f"release: {release['html_url']}")
        print(f"upload: {release['upload_url']}")
        with open("upload_url.txt", "w", encoding="utf-8") as handle:
            handle.write(release["upload_url"])
    elif mode == "assets":
        with open("upload_url.txt", encoding="utf-8") as handle:
            upload_url = handle.read().strip().replace("{?name,label}", "")
        files = [
            (r"D:\deepseek\tongyun-bci-web\desktop\release\TongYun-BCI-Setup-1.0.0.exe",
             "TongYun-BCI-Setup-1.0.0.exe"),
            (r"D:\deepseek\tongyun-bci-web\desktop\release\TongYun-BCI-Portable-1.0.0.exe",
             "TongYun-BCI-Portable-1.0.0.exe"),
        ]
        import urllib.parse

        for path, name in files:
            with open(path, "rb") as handle:
                data = handle.read()
            url = f"{upload_url}?name={urllib.parse.quote(name)}"
            print(f"uploading {name} ({len(data) / 1024 / 1024:.1f} MB)…", flush=True)
            asset = api_request(url, "POST", data, "application/octet-stream")
            print(f"  done: {asset.get('browser_download_url')}", flush=True)
        print("ALL ASSETS UPLOADED")


if __name__ == "__main__":
    main()
