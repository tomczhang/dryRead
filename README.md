# dryRead — 脱水阅读

> 脱去水分，留下真正有用的东西。

会思考的 AI 阅读助手（Chrome 侧栏插件）。点击工具栏图标即弹出侧栏，对**当前页签**的文章：

- 🎯 先判断值不值得读、哪些部分值得读
- 🧪 给出 **干货浓度**（0-100）与结论徽章（值得精读 / 可略读 / 不值得读）
- ✍️ 一句话总结（≤40 字）
- 💎 提炼最精华的观点
- ⚡️ 挑出最新奇的观点
- 💡 给出启发
- 📌 沉淀可复用的知识（可一键复制为 Markdown 存进笔记）

不支持粘贴文字/网址——它只干一件事：把你眼前这个页面拧干。

## 安装

1. 克隆本仓库（或下载 zip 解压）
2. 打开 `chrome://extensions`，右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库根目录
4. 点击工具栏的 dryRead 图标，侧栏弹出

> 需要 Chrome 116+（使用了 Side Panel API）。

## 配置模型

侧栏右上角 ⚙️ 进入设置：

| 配置项 | 说明 | 示例 |
| --- | --- | --- |
| 请求地址 | OpenAI 兼容接口，填到 `/v1` 这一级即可，自动补 `/chat/completions`；填完整端点也可以 | `https://api.openai.com/v1` |
| API Key | 仅保存在本机 `chrome.storage.local`，不会上传 | `sk-...` |
| 模型名称 | 任意 OpenAI 格式模型 | `gpt-4o-mini` / `deepseek-chat` / `qwen-plus` |

填好后可点「测试连接」验证，通过即可开始脱水。

## 工作原理

1. 从当前页签提取正文（优先 `article`/`main`/微信公众号 `#js_content`，自动剔除导航、页脚、脚本等噪音；超长正文按头 80% + 尾 20% 截断）
2. 携带「脱水提示词」调用你配置的模型（支持 SSE 流式与非流式响应）
3. 模型按约定返回严格 JSON，插件解析、兜底规整后渲染到侧栏

隐私说明：页面正文只会发送到**你自己配置的**接口地址，插件本身不收集任何数据。

## 开发与测试

```bash
# 核心逻辑单测（URL 规整 / 提示词构建 / SSE 解析 / JSON 提取 / 模型回复全链路）
npm test

# UI 预览（mock chrome API 与模型回复，无需真实 API Key）
python3 -m http.server 8765
# 打开 http://localhost:8765/test/preview.html
```

## 目录结构

```
manifest.json        # MV3 清单（sidePanel + scripting + storage）
background.js        # 点击图标打开侧栏
src/llm.js           # 纯逻辑：提示词、URL 规整、SSE 解析、JSON 提取（可在 Node 中单测）
src/sidepanel.*      # 侧栏 UI（Glasp 风格）与主流程
test/llm.test.js     # node --test 单测（18 例）
test/preview.html    # mock 环境的 UI 预览
```
