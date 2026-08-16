# HELLO WORLD 摩斯码回归数据

本目录包含 10 份 FIF 数据：`01` 为正确拼接，其余 9 份分别注入不同的点划、字符或单词边界错误。

EEG 片段来自 BCI Competition IV Dataset 2b 的真实 C3、Cz、C4 运动想象 epoch。用于生成文件的本地预处理缓存不提交到仓库；每个片段的被试、session、源索引、裁切范围和 SHA-256 均保存在 `manifest.json`。

刺激通道 `STI 014` 编码如下：

- `1`：左手运动想象，摩斯点 `.`
- `2`：右手运动想象，摩斯划 `-`
- `3`：字符边界
- `4`：单词边界

运行 `python backend/backend.py` 后，在网页的波形面板拖入 FIF 文件即可验证事件到摩斯文本的链路（`02` 应解码为 BELLO WORLD 并给出 HELLO WORLD 纠错建议）。

这些文件使用事件真值保证预期文本，仅用于拼接和状态机回归，不代表 Hybrid FBC-MIFormer 的盲测分类准确率。
