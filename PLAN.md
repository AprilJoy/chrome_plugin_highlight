# YouTube、X 与 B 站内容总结实现计划

## 目标与验收

在现有 Chrome MV3 侧栏里，用户打开 YouTube 视频、X 帖子或 B 站视频后，点击现有“生成摘要与关键字”，看到来自视频字幕或帖子正文的摘要、关键字和可查看的原始文本，仍可编辑并保存到现有飞书表。普通网页和右键段落流程继续工作。

- YouTube：读取当前视频的可用字幕轨道和带时间戳的字幕，不把推荐、评论或播放器文字当作视频内容。无字幕时给出明确提示。可选 Supadata Key 可作为字幕获取的后备来源。
- X：总结当前帖子的正文，不混入回复和推荐帖；纯视频帖子可选用 Supadata 取字幕。受保护或无法读取的帖子明确失败。
- B 站：根据当前 BV 号及 `?p=` 选择分 P，使用浏览器登录态查已有字幕，先查无需 WBI 签名的 `/x/player/v2` JSON 字幕轨道；若没有中文人工或中文 AI 轨道，再查 `/x/v2/subtitle/web/view` Protobuf 字幕轨道。合并候选后优先 `lan=zh-CN/zh-Hans/zh` 等人工中文轨道，其次 `lan=ai-zh`，最后其他可用轨道。全程不下载媒体、不运行 ASR/Whisper，也不读取或保存 Cookie 字符串。无字幕时明确失败。
- 视频统一为 `{source, url, title, language, transcriptKind, segments:[{startMs,endMs,text}]}`；X 文字帖子使用 `transcriptKind:"text"`、单段 `startMs=endMs=0`，格式化原文时不加时间戳。归一化后的可读原文（含时间戳与换行）最长 80,000 字，超过则明确报错；5,000 字/块，最多 16 块，多级归纳覆盖首尾全部内容，不能静默只取前 4000 字。保存时沿用飞书 8 列，类型分别为“视频”/“帖子”/“文章”，视频原文带时间戳，帖子原文为纯文本。

## 已查现状与依据

- `src/background.js`：`GENERATE` 始终调用 `extractActiveTabContent()` 与 `callLLM()`；`GET_PAGE_INFO` 通过注入读当前页面；`SAVE_RECORD` 已支持类型字段。
- `src/lib/extract.js`：普通网页抽取上限 4000 字，不能用于视频。
- `src/lib/llm.js`：仅一次 chat completion，摘要提示词按“文章类型”编写；需要加来源信息与长文本归纳。
- `src/sidepanel.js`：只显示当前页面和生成结果，保存时未携带来源类型；切换标签时旧摘要可能与新 URL 混合。
- `manifest.json`：现有 `<all_urls>` host permission 和 scripting 能力足以覆盖平台提取，无须 `cookies` 权限。`test/e2e.mjs` 的扩展目录写死为另一处路径，需修正。
- [B 站参考实现](https://github.com/ccBilly-aipm/bilibili-ai-subtitle)：旧 `/x/player/wbi/v2` 与新 `/x/v2/subtitle/web/view`，其[解码代码](https://github.com/ccBilly-aipm/bilibili-ai-subtitle/blob/main/src/bilibili_ai_subtitle/protobuf.py)明确将新接口按 Protobuf 解码；字幕文件本身为 JSON，`body` 含 `from/to/content`。[B 站 API 文档](https://github.com/BACNext/bilibili-API-collect-backup/blob/master/docs/video/player.md)同时列出无需 WBI 签名的 `/x/player/v2` JSON 端点，本扩展优先采用它。
- [Supadata 多平台接口](https://github.com/supadata-ai/skills/blob/main/skills/supadata/references/video.md)：`GET /transcript?url=...&mode=native` 返回字幕片段，长任务可返回 202/jobId。仅作可选后备，不引入必需付费依赖；其 `auto` 会触发 AI 转录，不符合 B 站约束。

## 关键选择与取舍

1. 保持零构建依赖、原生 JS。用来源适配器分离平台规则，`background` 仅做 URL 路由和编排；统一归一化结构交给同一摘要模块。
2. YouTube 在用户点击生成时从当前播放器对象的 `getPlayerResponse()` 读取 `captionTracks`：普通 watch/live/embed 页面尝试 `#movie_player`，Shorts 尝试 `#shorts-player`，并解析地址栏 `/watch?v=`、`/shorts/<id>`、`/live/<id>`、`/embed/<id>` 得到当前 videoId。校验播放器返回的 `videoId` 与当前地址一致；若不一致，等待短暂重试后报错，不读取可能过期的页面初始变量。若该页面没有可用播放器对象且 Supadata 未配置，明确提示该页面类型暂无法读取字幕。轨道 timedtext URL 仅允许 YouTube HTTPS 域名与 `/api/timedtext` 路径，取 JSON3。该非公开结构可能变化；配置 Supadata Key 后可回退到其 `mode=native` 字幕接口。X 正文从当前帖 DOM 读取，X 纯视频仅在有 Supadata Key 时以 `mode=native` 取字幕，不触发 AI 转录。
3. B 站从用户打开的视频页面的 MAIN world 发同站点会话请求（`credentials:"include"`，`www.bilibili.com` → `api.bilibili.com`，SameSite 同站），优先 `/x/player/v2` JSON；只有已得到中文人工或中文 AI 轨道时可直接选轨，否则继续查 Protobuf 新接口并合并轨道，再按全局优先级选轨。旧接口只有非中文轨道而新接口有 `ai-zh` 时必须选 `ai-zh`；新接口出错时不得静默退回其他语言，需提示字幕轨道查询失败。如页面 fetch 受 CORS 限制，再尝试扩展 SW fetch。两个来源都需检查 HTTP 状态、B 站 `code` 和字幕轨道，不能把鉴权/风控失败误报为“无字幕”。真实登录态验证必须覆盖：播放器可看到 AI 字幕、扩展能读取轨道；若失败，展示会话/平台限制及手动核验方法，不要求 `cookies` 权限。只请求视频元数据与字幕文件。字幕 URL 仅允许 HTTPS 的 `*.bilibili.com` 或 `*.hdslb.com`，CDN 请求使用 `credentials:"omit"`，不把 Cookie 发给字幕文件主机。参考项目为 Python CLI，按接口思想重写为 JS，避免安装 Python 后端。
4. B 站 JSON 字幕轨道用 `lan` 判别：非 `ai-*` 中文语言码视为人工中文，`ai-zh` 视为 AI 中文；Protobuf 按参考项目字段 1 包数据、重复字段 3 包轨道、轨道字段 3/4/5 为语言/显示名/URL。若接口格式意外变化，报“字幕元数据格式不受支持”，不伪造空字幕。字幕 JSON `from/to` 为秒，转换到毫秒；YouTube JSON3 `tStartMs/dDurationMs` 为毫秒；Supadata `offset/duration` 为毫秒，缺 duration 时用下一个 offset 合成 endMs，最后一个取 startMs。均检查非负、递增与非空文本；`transcriptKind:"text"` 的零时间段不加时间戳。
5. 单段字幕保持时间戳，用于跨平台统一分析和可读原文。先归一化并检查 80,000 字上限，再按每块最多 5,000 字切分；尽量在字幕段边界切，若段边界造成块数超过 `ceil(总字符数/5000)`，也可拆分中等长度字幕段（拆出的片段继承该段时间轴），保证不超过 16 块。各块生成不超过 350 字的事实要点，再每 5,000 字一组逐级归并，最终得到现有约 100 字摘要。普通网页仍用现有 `extract.js` 的 4,000 字限制，视频不走此路径。任一请求失败则整体失败，不保存不完整摘要。
6. 侧栏显示来源/字幕类型，保存当前生成结果的 URL、标题、类型和原文；只在活动标签变化或 URL 变化时清除待保存结果，标题变化只更新显示，不清空用户编辑。面板用 `chrome.windows.getCurrent()` 获取自身窗口 ID，并传给后台查询该窗口的活动 tab，避免多窗口误路由。飞书现有列结构保持不变。

## 文件与实施步骤

1. `src/lib/content.js`：来源 URL 判定、片段归一化、字幕时间戳格式化、上述大小校验与必要的段内拆分。新增 `test/content.test.mjs`，覆盖 YouTube watch/shorts/live/embed、X/B 站 URL、分 P、三套时间单位、纯文本无时间戳、空字幕、80,000 字边界，以及 18 段各约 3,900 字仍能装入 16 块。
2. `src/lib/youtube.js`：页面主世界从实时播放器对象抽取当前视频的轨道元数据，校验 videoId/timedtext URL 后抓 JSON3 并归一化；需要时 `src/lib/supadata.js` 用可选 Key 取原生字幕，处理同步/202 轮询、超时及错误。使用 stubbed `fetch` 的测试覆盖手工/自动字幕、SPA 切换后的新轨道、视频 ID 不一致、空轨道、无效 URL、Supadata 时间轴与异步任务。
3. `src/lib/bilibili.js`：BV/p 解析、视频元数据、`/x/player/v2` JSON 轨道、新接口 Protobuf 最小解码器、轨道选择与字幕 JSON 归一化。测试以合成 Protobuf fixture 与 stubbed fetch 覆盖登录缺失、旧接口空、新接口有字幕、旧接口只有非中文而新接口有 `ai-zh` 时选择 `ai-zh`、分 P、无字幕、不可信字幕地址，以及页面会话请求与 SW 后备。明确断言旧端点为 `/x/player/v2`，无需 `w_rid`。
4. `src/lib/x.js`：在当前帖子页面抽取主帖正文，识别文本缺失时的媒体内容；测试覆盖主帖/回复分离、空帖。可选 Supadata 仅针对纯视频帖子。
5. `src/lib/llm.js`、`src/background.js`：按来源路由并对长内容分块归纳；配置增加可选 Supadata Key，`GENERATE` 返回来源与字幕标记，保留普通网页/右键保存路径。测试 LLM 分块覆盖首尾字幕及失败传播，stubbed Chrome API 验证按窗口 ID 路由。
6. `src/sidepanel.*`、`src/options.*`、`README.md`、`DESIGN.md`、`test/e2e.mjs`：展示来源/字幕状态、配置可选 Key、保存正确类型并修复切页旧数据。更新使用与限制说明，e2e 使用仓库相对路径，验证配置、标题变动不清稿、URL/标签变化清稿与 UI 流程。

## 验证合同

- `node --test test/*.test.mjs`：解析、路由、协议、分块与错误路径均通过。
- `node test/e2e.mjs`：Chrome 扩展可加载，原有配置与侧栏回归通过，新设置与来源状态断言通过。若环境无法启动 headed Chromium，记录具体环境故障并至少运行可用的无头扩展测试。
- `node --check src/background.js`，并对新增/修改的 JS 文件运行语法检查。
- 手动核对：一个有字幕 YouTube 视频、一个文字 X 帖、一个已登录且有字幕的 B 站视频；检查首末字幕、来源标记、摘要与保存字段。真实 LLM、飞书及平台登录态需要用户已有凭据；无凭据时明确记录未验证项目，不宣称端到端通过。

## 风险与非目标

- YouTube 与 B 站播放器内部接口随平台变化；用错误信息和可选来源回退降低影响，真实平台验证仍需当前登录环境。
- X 受保护、未加载正文的帖子不能绕过权限；有媒体而无字幕的内容不会自动语音转写。
- 不新增后端、媒体下载、Whisper、批量 URL 队列或飞书新列。
