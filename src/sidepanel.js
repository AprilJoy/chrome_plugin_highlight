// Side panel 主逻辑：生成摘要 -> 编辑关键字 -> 写感想 -> 保存到飞书

const $ = (id) => document.getElementById(id);
const els = {
  title: $("title"),
  url: $("url"),
  source: $("source"),
  settings: $("settings"),
  generate: $("generate"),
  outputLanguage: $("output-language"),
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
let generatedRecord = null;
let panelWindowId = null;
let pageLoadSequence = 0;
// 当前关键字数组
let keywords = [];
let summaryPrefs = { complexity: 'standard', language: 'zh' };

function syncSummaryPrefsUI() {
  document.querySelectorAll('.seg-btn').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.complexity === summaryPrefs.complexity));
  });
  els.outputLanguage.value = summaryPrefs.language;
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = "status" + (kind ? " " + kind : "");
}

async function send(type, payload = {}) {
  try {
    if (panelWindowId === null) panelWindowId = (await chrome.windows.getCurrent()).id;
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, windowId: panelWindowId, ...payload }, (resp) => resolve(resp));
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function clearGenerated() {
  generatedRecord = null;
  els.summary.value = "";
  els.content.value = "";
  els.notes.value = "";
  els.source.textContent = "";
  keywords = [];
  renderKeywords();
  els.save.disabled = true;
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
  const feishuReady = !!(feishu.appId && feishu.appSecret && feishu.appToken && feishu.tableId);
  els.generate.disabled = !llm.apiKey;
  els.save.disabled = !generatedRecord || !feishuReady;
  if (quiet) return;
  if (!llm.apiKey) {
    setStatus("未配置 LLM API Key，请点右上角⚙设置", "err");
  } else if (!feishuReady) {
    setStatus("未配置飞书，请点右上角⚙设置", "err");
  } else if (!generatedRecord) {
    setStatus("先生成摘要，再保存到飞书");
  } else {
    setStatus("");
  }
}

// 生成摘要
async function onGenerate() {
  await loadCurrentPage();
  const startedAt = { tabId: currentPage.tabId, url: currentPage.url };
  setStatus("正在抓取页面并生成摘要…", "loading");
  els.generate.disabled = true;
  try {
    const resp = await send("GENERATE", { complexity: summaryPrefs.complexity, language: summaryPrefs.language });
    if (!resp || !resp.ok) throw new Error(resp ? resp.error : "无响应");
    const { summary, keywords: kws, url, title, content, source, transcriptKind, language, recordType, tabId } = resp.data;
    if (currentPage.tabId !== tabId || currentPage.url !== url || startedAt.tabId !== tabId) {
      throw new Error('生成期间页面已切换，请重新生成');
    }
    generatedRecord = { url, title, content, type: recordType, tabId };
    els.title.textContent = title;
    els.url.textContent = url;
    els.url.href = url;
    els.summary.value = summary;
    els.content.value = content;
    const labels = { youtube: 'YouTube', bilibili: 'B 站', x: 'X 帖子', article: '网页' };
    const kind = transcriptKind === 'ai' ? 'AI 字幕' : transcriptKind === 'manual' ? '人工字幕' : transcriptKind === 'caption' ? '平台字幕' : '';
    els.source.textContent = [labels[source] || source, kind, language].filter(Boolean).join(' · ');
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
  if (!generatedRecord || generatedRecord.url !== currentPage.url || generatedRecord.tabId !== undefined && generatedRecord.tabId !== currentPage.tabId) {
    setStatus("没有页面信息，请先生成摘要", "err");
    return;
  }
  setStatus("正在保存到飞书…", "loading");
  els.save.disabled = true;
  try {
    const resp = await send("SAVE_RECORD", {
      record: {
        type: generatedRecord.type,
        title: generatedRecord.title,
        url: generatedRecord.url,
        summary,
        keywords,
        content: generatedRecord.content,
        notes: els.notes.value.trim(),
      },
    });
    if (!resp || !resp.ok) throw new Error(resp ? resp.error : "无响应");
    setStatus("已保存到飞书 ✓", "ok");
    // 清空，准备下一条
    clearGenerated();
  } catch (e) {
    setStatus("保存失败：" + e.message, "err");
  } finally {
    await refreshConfigState(true);
  }
}

// 加载当前页面标题与 URL（轻量，不抓正文）
async function loadCurrentPage() {
  const sequence = ++pageLoadSequence;
  const resp = await send("GET_PAGE_INFO");
  if (sequence !== pageLoadSequence) return;
  if (resp && resp.ok && resp.data) {
    const next = { url: resp.data.url, title: resp.data.title, tabId: resp.data.tabId };
    if (currentPage.url && (currentPage.url !== next.url || currentPage.tabId !== next.tabId)) clearGenerated();
    currentPage = next;
    els.title.textContent = resp.data.title || resp.data.url;
    els.url.textContent = resp.data.url;
    els.url.href = resp.data.url;
  } else {
    clearGenerated();
    currentPage = { url: "", title: "" };
    els.title.textContent = "（无法读取当前页面）";
    els.url.textContent = "";
    els.url.href = "";
  }
}

// 初始化
async function init() {
  const stored = await chrome.storage.local.get('summaryPrefs');
  const prefs = stored.summaryPrefs;
  summaryPrefs = {
    complexity: ['concise', 'standard', 'detailed'].includes(prefs?.complexity) ? prefs.complexity : 'standard',
    language: prefs?.language === 'en' ? 'en' : 'zh',
  };
  syncSummaryPrefsUI();
  document.querySelectorAll('.seg-btn').forEach((button) => {
    button.addEventListener('click', () => {
      summaryPrefs = { ...summaryPrefs, complexity: button.dataset.complexity };
      syncSummaryPrefsUI();
      chrome.storage.local.set({ summaryPrefs });
    });
  });
  els.outputLanguage.addEventListener('change', () => {
    summaryPrefs = { ...summaryPrefs, language: els.outputLanguage.value };
    chrome.storage.local.set({ summaryPrefs });
  });
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
    if (info.url) loadCurrentPage();
  });
}

init();
