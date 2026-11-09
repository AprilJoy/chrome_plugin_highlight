// 设置页逻辑：LLM 厂商/Key/model + 飞书配置 + 测试连接

const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) =>
  new Promise((r) => chrome.runtime.sendMessage({ type, ...payload }, r)).catch(
    (e) => ({ ok: false, error: e.message })
  );

// 带超时的 send，避免 SW 被冻住时无限 loading
function sendWithTimeout(type, payload = {}, ms = 15000) {
  return Promise.race([
    send(type, payload),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("请求超时，service worker 可能已休眠，请稍后重试")), ms)
    ),
  ]);
}

let providers = {};

async function load() {
  const [cfgResp, provResp] = await Promise.all([
    send("GET_CONFIG"),
    send("GET_PROVIDERS"),
  ]);
  const cfg = cfgResp.ok ? cfgResp.data : {};
  const llm = cfg.llm || {};
  const feishu = cfg.feishu || {};
  if (!cfgResp || !cfgResp.ok || !provResp || !provResp.ok) {
    $("saveResult").textContent = "加载配置失败";
    return;
  }
  const config = cfgResp.data;
  providers = provResp.data;

  const providerSel = $("provider");
  Object.entries(providers).forEach(([key, p]) => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = p.label;
    providerSel.appendChild(opt);
  });
  providerSel.value = config.llm.provider || "deepseek";

  $("apiKey").value = config.llm.apiKey || "";
  $("appId").value = config.feishu.appId || "";
  $("appSecret").value = config.feishu.appSecret || "";
  $("appToken").value = config.feishu.appToken || "";
  $("tableId").value = config.feishu.tableId || "";
  $("supadataKey").value = config.supadata?.apiKey || "";

  renderModelOptions(config.llm.model || "");
  providerSel.addEventListener("change", () => renderModelOptions(""));
}

function renderModelOptions(selected) {
  const list = $("model-suggestions");
  list.innerHTML = "";
  const p = providers[$("provider").value];
  if (!p) return;
  p.models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    list.appendChild(opt);
  });
  $("model").placeholder = `留空用默认（${p.defaultModel}），或填具体 model id`;
  $("model").value = selected || "";
}

function gather() {
  return {
    llm: {
      provider: $("provider").value,
      apiKey: $("apiKey").value.trim(),
      model: $("model").value,
    },
    feishu: {
      appId: $("appId").value.trim(),
      appSecret: $("appSecret").value.trim(),
      appToken: $("appToken").value.trim(),
      tableId: $("tableId").value.trim(),
    },
    supadata: { apiKey: $("supadataKey").value.trim() },
  };
}

$("save").addEventListener("click", async () => {
  const resp = await send("SAVE_CONFIG", { config: gather() });
  const el = $("saveResult");
  if (resp && resp.ok) {
    el.className = "result ok";
    el.textContent = "已保存 ✓";
  } else {
    el.className = "result err";
    el.textContent = "失败：" + (resp ? resp.error : "无响应");
  }
});

$("testLlm").addEventListener("click", async () => {
  await send("SAVE_CONFIG", { config: gather() });
  const el = $("testLlmResult");
  el.className = "result";
  el.textContent = "测试中…";
  let resp;
  try {
    resp = await sendWithTimeout("TEST_LLM");
  } catch (e) {
    el.className = "result err";
    el.textContent = e.message;
    return;
  }
  if (!resp || !resp.ok) {
    el.className = "result err";
    el.textContent = "失败：" + (resp ? resp.error : "无响应");
    return;
  }
  el.className = "result ok";
  el.textContent = `连接成功 ✓（模型 ${resp.data.model}，回复「${resp.data.reply}」）`;
});

$("test").addEventListener("click", async () => {
  await send("SAVE_CONFIG", { config: gather() });
  const el = $("testResult");
  el.className = "result";
  el.textContent = "测试中…";
  let resp;
  try {
    resp = await sendWithTimeout("TEST_FEISHU");
  } catch (e) {
    el.className = "result err";
    el.textContent = e.message;
    return;
  }
  if (!resp || !resp.ok) {
    el.className = "result err";
    el.textContent = "失败：" + (resp ? resp.error : "无响应");
    return;
  }
  const data = resp.data || {};
  const missing = data.missing || [];
  const suggestions = data.suggestions || [];
  if (missing.length === 0 && suggestions.length === 0) {
    el.className = "result ok";
    el.textContent = "连接成功，字段齐全 ✓";
    return;
  }
  el.className = "result err";
  if (suggestions.length > 0) {
    el.textContent = suggestions.join("；");
  } else {
    el.textContent = "连接成功，但表里缺少列：" + missing.join("、");
  }
  const detail = document.createElement("div");
  detail.className = "result";
  detail.style.color = "var(--muted)";
  detail.style.marginTop = "6px";
  detail.style.fontSize = "12px";
  detail.style.wordBreak = "break-all";
  detail.textContent = "飞书表实际列名：" + (data.existing || []).join("、");
  el.appendChild(detail);
});

load();
