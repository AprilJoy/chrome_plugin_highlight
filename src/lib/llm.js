// LLM 适配层：统一封装 DeepSeek / 智谱 GLM / 通义千问
// 三家均兼容 OpenAI Chat Completions 格式，仅 base_url / model / api_key 不同。
//
// 由 background.js 通过 importScripts 引入，函数挂到 globalThis。
// 对外接口：
//   globalThis.PROVIDERS          厂商元信息（供 options 页渲染下拉）
//   globalThis.callLLM(config, title, content) -> { summary, keywords }

globalThis.PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  zhipu: {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.1",
    models: ["glm-5.1", "glm-4.5", "glm-4-flash"],
  },
  qwen: {
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-turbo",
    models: ["qwen-turbo", "qwen-plus", "qwen-max"],
  },
};

const SYSTEM_PROMPT =
  "你是网页内容摘要助手。先判断文章类型（评论型 / 操作性），再按规则生成摘要。\n" +
  "摘要主体以子弹笔记（bullet journal）形式呈现：层级化要点，一级前缀「• 」，二级「  ◦ 」，三级「    — 」，靠缩进体现从属关系；主体总字数控制在 100 字左右。\n" +
  "在主体末尾另起一行，按文章类型加收尾句：\n" +
  "  · 评论型文章（表达观点/评价/论述）：加一行「■ 总结：」+ 一句总结概括；\n" +
  "  · 操作性文章（教程/指南/步骤/实操）：加一行「■ 建议：」+ 一句可行性建议与执行方向。\n" +
  "另外提取不超过 3 个关键字。\n" +
  '只返回 JSON，格式为 {"summary": string, "keywords": string[]}，' +
  "summary 是多行文本（保留换行与缩进），keywords 数组最多 3 个，不要输出任何额外文字。";

function parseLLMJson(text) {
  if (!text) return null;
  // 直接解析
  try {
    return JSON.parse(text);
  } catch (e) {}
  // 尝试提取第一个 {...}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch (e) {}
  }
  return null;
}

// 内部：实际发起请求
async function requestChat(config, messages, { allowJsonFormat = true } = {}) {
  const provider = globalThis.PROVIDERS[config.provider];
  const model = config.model || provider.defaultModel;
  const url = `${provider.baseUrl}/chat/completions`;
  const body = {
    model,
    messages,
    temperature: 0.3,
  };
  if (allowJsonFormat) {
    body.response_format = { type: "json_object" };
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const err = new Error(
      `LLM 请求失败 (${resp.status}): ${errText.slice(0, 300)}`
    );
    err.status = resp.status;
    err.body = errText;
    throw err;
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

// 测试 API Key 连通性：发一个最简短的对话请求，不要求 JSON 输出
// 成功返回 { model, reply }，失败抛错
globalThis.testLLM = async function testLLM(config) {
  if (!config || !config.provider || !config.apiKey) {
    throw new Error("未填写厂商或 API Key");
  }
  const provider = globalThis.PROVIDERS[config.provider];
  if (!provider) {
    throw new Error(`未知 LLM 厂商: ${config.provider}`);
  }
  const model = config.model || provider.defaultModel;
  const messages = [
    { role: "user", content: "回复两个字：正常" },
  ];
  const text = await requestChat(config, messages, { allowJsonFormat: false });
  return { model, reply: text.trim().slice(0, 50) };
};

globalThis.callLLM = async function callLLM(config, title, content) {
  if (!config || !config.provider || !config.apiKey) {
    throw new Error("未配置 LLM 厂商或 API Key，请到设置页配置");
  }
  if (!globalThis.PROVIDERS[config.provider]) {
    throw new Error(`未知 LLM 厂商: ${config.provider}`);
  }

  const userMessage = `标题：${title}\n\n正文：\n${content}`;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  let text;
  try {
    text = await requestChat(config, messages, { allowJsonFormat: true });
  } catch (e) {
    // 某些模型/账号不支持 response_format，降级重试一次
    if (e.status === 400) {
      text = await requestChat(config, messages, { allowJsonFormat: false });
    } else {
      throw e;
    }
  }

  const parsed = parseLLMJson(text);
  if (!parsed) {
    throw new Error("LLM 返回内容无法解析为 JSON: " + text.slice(0, 200));
  }
  return {
    summary: String(parsed.summary || "").trim(),
    keywords: Array.isArray(parsed.keywords)
      ? parsed.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 3)
      : [],
  };
};
