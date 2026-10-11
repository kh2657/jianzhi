# 数学学习工作台助手（浏览器扩展）

Chrome / Edge 通用（Chromium MV3）。把当前论文网页或 PDF 一键导入本机运行的数学学习工作台：书目元数据来自页面的 citation 标签，PDF 只发往本机 `127.0.0.1`，无任何上传。

安装与令牌获取见工作台内「文献库 → 浏览器导入」弹窗（连接地址、令牌与安装步骤都在那里）。

## 文件

- `manifest.json` — MV3 清单（权限仅限本机通信 + 页面元数据读取 + 下载兜底）
- `background.js` — 后台脚本：服务探测、元数据抓取、PDF 抓取（付费墙走下载落盘兜底）、提交与角标反馈
- `options.html` / `options.js` — 选项页：服务地址、连接令牌、测试连接
- `icons/` — 由 `scripts/gen-extension-icons.mjs` 生成（改图标请改脚本后重跑）
