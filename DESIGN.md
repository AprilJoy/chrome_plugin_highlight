# Chrome 插件：网页摘要与笔记收集器 — 产品设计文档

## 背景与目标

把"读网页 → 摘要 → 记笔记 → 归档"这一串动作在一个浏览器面板里完成。点开任意网页，插件用 LLM 生成约 100 字的**子弹笔记式摘要**和最多 **3 个关键字**，用户可手动增删关键字、填写阅读感想，一键把记录写入飞书多维表格（Bitable）。飞书表即唯一存储。同时支持**右键菜单快速保存**：选中网页中的任意段落，右键点击"保存为段落"，弹出对话框输入想法后直接保存。

## 已对齐的关键决策

- **LLM**：多家可切换（DeepSeek / 智谱 GLM / 通义千问），用户在设置页自填 API Key，扩展直连厂商接口（三家均兼容 OpenAI Chat Completions 格式，CORS 允许浏览器直连）。
- **存储**：仅飞书多维表格 Bitable，不做本地 CSV。
- **关键字**：LLM 自动提取最多 3 个，用户可在面板里手动增删改。
- **摘要**：子弹笔记格式，按文章类型收尾（评论型加总结、操作型加建议）。
- **原文**：自动抓取并转换为 Markdown 格式，保留结构（标题、列表、链接、代码块等）。
- **右键菜单**：支持快速保存选中段落，自动打开对话框让用户输入想法，直接保存为"段落"类型。

## 技术选型

- **Manifest V3**，service worker + side panel（空间足够展示摘要/关键字/感想）。
- 纯原生 JS，**不引入构建工具**；正文提取用轻量自有实现，零依赖。
- 三家 LLM 厂商 API 均兼容 OpenAI 格式，只需切换 `base_url` / `model` / `api_key`，一个适配层即可。

## 文件结构

```
chrome_plugin_highlight/
├── manifest.json
├── src/
│   ├── background.js                    # service worker：消息路由 + 编排
│   ├── sidepanel.html / .css / .js      # 侧边栏主界面
│   ├── options.html / .css / .js        # 设置页
│   ├── quote-dialog.html / .js          # 右键菜单段落保存对话框
│   └── lib/
│       ├── extract.js                   # 页面正文提取 → Markdown 格式
│       ├── llm.js                       # 多厂商 LLM 适配（含模型字段可自由输入）
│       └── feishu.js                    # 飞书 Bitable 接入（含字段模糊匹配）
├── icons/                               # 16 / 48 / 128
├── test/
│   └── e2e.mjs                          # Playwright 回归脚本
├── DESIGN.md                            # 产品设计文档
└── README.md                            # 安装与使用文档
```

## 关键实现细节

### 1. manifest.json（MV3）
- `permissions`: `sidePanel`, `activeTab`, `scripting`, `storage`
- `host_permissions`: `["<all_urls>"]`（保证 `executeScript` 注入任意网页不再依赖 activeTab 时序）
- `side_panel.default_path`: `src/sidepanel.html`
- `background.service_worker`: `src/background.js`
- `action`: 点击图标打开 side panel（通过 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`）
- `options_page`: `src/options.html`

### 2. 内容提取（lib/extract.js）
- `extractPageContent` 由 background 通过 `chrome.scripting.executeScript({ func })` 注入页面执行，自包含。
- clone 整个 document，移除 script/style/nav/footer 等噪声标签，优先取 `article/main/[role=main]/.content` 等正文容器，兜底 `body`，取 `textContent`。
- **DOM 转 Markdown**：保留页面结构，支持：
  - 标题（H1-H6）→ `# ## ### ...`
  - 列表（ul/ol）→ `- ` 符号
  - 加粗/斜体（strong/em）→ `**text**` / `*text*`
  - 链接（a）→ `[text](url)`
  - 代码块（pre）→ ` ``` `
- 规整空白后截断到 4000 字，避免超出 LLM 上下文。

### 3. LLM 适配（lib/llm.js）
- 三家配置（`PROVIDERS` 对象）：
  - DeepSeek: `https://api.deepseek.com/v1`，`deepseek-chat` / `deepseek-reasoner`
  - 智谱 GLM: `https://open.bigmodel.cn/api/paas/v4`，`glm-5.1`（默认）/ `glm-4.5` / `glm-4-flash`
  - 通义千问: `https://dashscope.aliyuncs.com/compatible-mode/v1`，`qwen-turbo` / `qwen-plus` / `qwen-max`
- **模型字段可自由输入**：设置页用 `<input list="model-suggestions">` + `<datalist>`，厂商出新模型时用户在输入框填 model id 即可，不用等代码更新。
- 统一 prompt：要求返回 JSON `{summary, keywords}`，`response_format: json_object`（400 错误时降级重试）。

#### 摘要生成规则
1. **先判断文章类型**（评论型 / 操作性）
2. **主体**用子弹笔记呈现：层级化要点，一级前缀 `• `、二级 `  ◦ `、三级 `    — `，靠缩进体现从属关系；主体总字数 ~100 字
3. **末尾收尾句**：
   - 评论型（观点/评价/论述）→ 加一行 `■ 总结：` + 一句总结概括
   - 操作性（教程/指南/步骤/实操）→ 加一行 `■ 建议：` + 一句可行性建议与执行方向
4. 关键字数组**最多 3 个**（prompt 要求 + 代码 `slice(0, 3)` 硬截断双保险）

#### 测试连通
`globalThis.testLLM(config)` 发最简请求（"回复两个字：正常"），不要求 JSON 输出，用于设置页「测试连接」按钮。

### 4. Side Panel 主 UI
- **顶部**：当前页面标题 + URL（可点跳转）。打开时自动通过 `GET_PAGE_INFO` 注入抓取；监听 `chrome.tabs.onActivated` / `onUpdated` 自动刷新。
- **生成摘要按钮**：调 background → content 抓正文 → LLM。
- **摘要区**（可编辑 textarea，等宽字体 + `white-space: pre-wrap` 让子弹笔记缩进对齐）。
- **关键字区**：chips 形式，可删除，末尾输入框回车新增；最多 3 个由 LLM 端控制，手动可自由改。
- **感想输入框**（多行）。
- **保存按钮**：调飞书追加一条记录；成功/失败明确提示。
- **保存成功后**清空摘要 / 关键字 / 感想，保留 URL 准备下一条。

#### 按钮可用性联动
- 打开时 + 配置变化时（`chrome.storage.onChanged`）自动刷新按钮状态
- 静默刷新（`quiet` 参数）保留底部成功提示，避免被覆盖

### 5. 飞书 Bitable（lib/feishu.js）
- 用户在 options 页配置：`app_id`, `app_secret`, `app_token`, `table_id`
- 鉴权：app_id + app_secret 换 `tenant_access_token`，缓存到 `chrome.storage.local`（带过期提前 60 秒刷新，鉴权失败自动清缓存重试一次）
- 字段映射（`FEISHU_FIELD_KEYS`）：标题、URL、**类型**、摘要、关键字、**原文**、感想、时间戳
- **类型**字段：支持 `"文章"` 和 `"段落"` 两种：
  - 通过 side panel 生成摘要后保存 → `type: "文章"`
  - 通过右键菜单快速保存 → `type: "段落"`
- **原文**字段：Markdown 格式的页面正文内容
- 关键字：数组 join `"; "`
- 时间戳：本地时区 `YYYY-MM-DD HH:MM:SS`

#### 字段检查（容错）
`feishuCheckFields` 返回三段信息，避免 1254045 FieldNameNotFound 排查困难：
1. `missing`：完全不存在的列
2. `suggestions`：去空白后能匹配上的列（提示「实际叫『标题 』（含空格）」）
3. `existing`：飞书表里实际的全部列名（便于核对）

### 6. 设置页（options.html）
- LLM：厂商下拉 + API Key + 模型可自由输入（带 datalist 建议项）
- 飞书：app_id/app_secret/app_token/table_id + 「测试连接」按钮
- 「测试连接」按钮并存于 LLM 卡片和飞书卡片，分别验证 API Key 与飞书表格
- 全部存 `chrome.storage.local`

## 数据流

```
点图标 → side panel 打开 → background 注入 GET_PAGE_INFO 拿 url+title
  → 用户点「生成摘要」→ content 抓正文 → LLM 生成摘要+关键字
  → 面板展示，用户编辑关键字/写感想 → 点保存
  → background 调 feishu.appendRecord(record)
  → 面板显示成功/失败
```

## Playwright 回归测试

`test/e2e.mjs`：启动 playwright 自带 chromium（不用系统 Chrome channel），加载未打包扩展，跑 9 项断言：

1. 扩展加载（拿到 service worker）
2. options：LLM / 飞书测试按钮存在
3. options：厂商下拉含智谱
4. options：保存成功提示
5. storage：config.llm.apiKey 已写入
6. side panel：配 key 后生成按钮可用
7. side panel：飞书未配时保存按钮禁用
8. side panel：假 key 下生成返回错误提示
9. 全部通过

> 局限：自动化里模拟不了「点图标打开 side panel」授予 activeTab，抓正文 + LLM 真链路留真实环境。

## 验证方式（端到端）

1. `chrome://extensions` → 开发者模式 → 加载 `chrome_plugin_highlight/` 目录
2. 扩展详情页把「网站访问权限」设为「在所有网站上」（首次加载 `<all_urls>` 后需要）
3. options 页：填 LLM Key → 点「测试连接」确认通；填飞书凭据 → 点「测试连接」确认字段齐全
4. 打开任一网页 → 点图标 → 生成摘要 → 编辑 → 写感想 → 保存到飞书
5. 检查飞书表有新记录，字段值正确

## 飞书多维表格建表模板

列名**必须与代码 `fields` 的 key 一字不差**（含空格、不可见字符）：

| 列名   | 字段类型 | 说明                          |
| ------ | -------- | ----------------------------- |
| 标题   | 多行文本 | 网页标题                      |
| URL    | 多行文本 | 网页地址                      |
| 类型   | 多行文本 | 文章 / 段落                   |
| 摘要   | 多行文本 | 子弹笔记形式，约 100 字       |
| 关键字 | 多行文本 | 分号连接，最多 3 个           |
| 原文   | 多行文本 | 页面正文（Markdown 格式）     |
| 感想   | 多行文本 | 用户填写的阅读感想或想法      |
| 时间戳 | 多行文本 | 本地时间 `YYYY-MM-DD HH:MM:SS` |

> URL 列建议用「多行文本」类型（代码存纯字符串）。若改成「链接」类型会写入失败。
> 列名对齐失败时，设置页「测试连接」会把飞书表实际列名全部列出，复制比对差异。

## 范围与取舍

- 存储仅飞书 Bitable，无本地落盘、无历史记录 UI（飞书表即历史）
- 飞书未配置时面板禁用保存按钮并提示去设置页配置
- 正文提取用轻量自有实现（`lib/extract.js`），**支持 Markdown 转换**，避免引入 npm/构建链
- 「类型」字段：
  - 通过 side panel 生成摘要后保存 → `type: "文章"`
  - 通过右键菜单快速保存 → `type: "段落"`
- 右键菜单：只在有选中文本时显示「保存为段落」，点击后自动打开对话框（window.open popup）
- 对话框（quote-dialog）通过 `chrome.storage.session` 传递数据，避免多窗口间的全局状态混乱
- **飞书个人版（含「个人企业」版）不支持应用作为多维表格协作者**——必须使用企业版（团队租户），详见 README