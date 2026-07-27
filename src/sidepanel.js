// Side panel 主逻辑：生成摘要 -> 编辑关键字 -> 写感想 -> 保存到飞书

const $ = (id) => document.getElementById(id);
const els = {
  title: $("title"),
  url: $("url"),
  settings: $("settings"),
  generate: $("generate"),
  summary: $("summary"),
  keywords: $("keywords"),
  keywordInput: $("keyword-input"),
  content: $("content"),
  notes: $("notes"),
  save: $("save"),
  status: $("status"),
};

// 当前页面信息（生成摘要后填充，保存时使用）
let currentPage = { url: "", title: "" };
// 当前关键字数组
let keywords = [];

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = "status" + (kind ? " " + kind : "");
}

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => resolve(resp));
  });
}

// 渲染关键字 chips
function renderKeywords() {
  // 清掉除输入框外的所有 chip
  Array.from(els.keywords.querySelectorAll(".chip")).forEach((el) => el.remove());
  keywords.forEach((kw, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const text = document.createElement("span");
    text.textContent = kw;
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "×";
    remove.title = "删除";
    remove.addEventListener("click", () => {
      keywords.splice(idx, 1);
      renderKeywords();
    });
    chip.appendChild(text);
    chip.appendChild(remove);
    els.keywords.insertBefore(chip, els.keywordInput);
  });
}

function addKeyword(kw) {
  kw = kw.trim();
  if (!kw) return;
  if (keywords.includes(kw)) return;
  keywords.push(kw);
  renderKeywords();
}

// 检查配置是否齐全，决定按钮可用性
// quiet=true 时只更新按钮状态，不动底部提示（用于生成/保存后的恢复）
async function refreshConfigState(quiet = false) {
  const resp = await send("GET_CONFIG");
  if (!resp || !resp.ok) return;
  const { llm, feishu } = resp.data;
  els.generate.disabled = !llm.apiKey;
  els.save.disabled = !feishu.appId || !feishu.appSecret || !feishu.appToken || !feishu.tableId;
  if (quiet) return;
  if (!llm.apiKey) {
    setStatus("未配置 LLM API Key，请点右上角⚙设置", "err");
  } else if (els.save.disabled) {
    setStatus("未配置飞书，请点右上角⚙设置", "err");
  } else {
    setStatus("");
  }
}

// 生成摘要
async function onGenerate() {
  setStatus("正在抓取页面并生成摘要…", "loading");
  els.generate.disabled = true;
  try {
    const resp = await send("GENERATE");
    if (!resp || !resp.ok) throw new Error(resp ? resp.error : "无响应");
    const { summary, keywords: kws, url, title, content } = resp.data;
    currentPage = { url, title, content };
    els.title.textContent = title;
    els.url.textContent = url;
    els.url.href = url;
    els.summary.value = summary;
    els.content.value = content;
    keywords = Array.isArray(kws) ? kws.slice() : [];
    renderKeywords();
    setStatus("已生成，可编辑后保存", "ok");
  } catch (e) {
    setStatus("生成失败：" + e.message, "err");
  } finally {
    await refreshConfigState(true);
  }
}

// 保存到飞书
async function onSave() {
  const summary = els.summary.value.trim();
  if (!currentPage.url) {
    setStatus("没有页面信息，请先生成摘要", "err");
    return;
  }
  setStatus("正在保存到飞书…", "loading");
  els.save.disabled = true;
  try {
    const resp = await send("SAVE_RECORD", {
      record: {
        title: currentPage.title,
        url: currentPage.url,
        summary,
        keywords,
        content: currentPage.content,
        notes: els.notes.value.trim(),
      },
    });
    if (!resp || !resp.ok) throw new Error(resp ? resp.error : "无响应");
    setStatus("已保存到飞书 ✓", "ok");
    // 清空，准备下一条
    els.summary.value = "";
    els.content.value = "";
    keywords = [];
    renderKeywords();
    els.notes.value = "";
  } catch (e) {
    setStatus("保存失败：" + e.message, "err");
  } finally {
    await refreshConfigState(true);
  }
}

// 加载当前页面标题与 URL（轻量，不抓正文）
async function loadCurrentPage() {
  const resp = await send("GET_PAGE_INFO");
  if (resp && resp.ok && resp.data) {
    currentPage = { url: resp.data.url, title: resp.data.title };
    els.title.textContent = resp.data.title || resp.data.url;
    els.url.textContent = resp.data.url;
    els.url.href = resp.data.url;
  } else {
    currentPage = { url: "", title: "" };
    els.title.textContent = "（无法读取当前页面）";
    els.url.textContent = "";
    els.url.href = "";
  }
}

// 初始化
function init() {
  els.generate.addEventListener("click", onGenerate);
  els.save.addEventListener("click", onSave);
  els.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());

  els.keywordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(els.keywordInput.value);
      els.keywordInput.value = "";
    }
  });

  renderKeywords();
  refreshConfigState();
  loadCurrentPage();

  // 配置在设置页被改动时，自动刷新按钮可用性
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.config) {
      refreshConfigState();
    }
  });

  // 切换标签或页面导航时，刷新当前页面信息
  chrome.tabs.onActivated.addListener(() => loadCurrentPage());
  chrome.tabs.onUpdated.addListener((_tabId, info) => {
    if (info.title || info.url) loadCurrentPage();
  });
}

init();
