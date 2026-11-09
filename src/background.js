// Service worker：消息路由 + 编排（抓正文 / 调 LLM / 写飞书）
// classic SW，用 importScripts 引入 lib（函数挂 globalThis）

importScripts("lib/content.js", "lib/supadata.js", "lib/youtube.js", "lib/bilibili.js", "lib/x.js", "lib/extract.js", "lib/llm.js", "lib/feishu.js");

const DEFAULT_CONFIG = {
  llm: { provider: "deepseek", apiKey: "", model: "" },
  supadata: { apiKey: "" },
  feishu: { appId: "", appSecret: "", appToken: "", tableId: "" },
};

async function getConfig() {
  const item = await chrome.storage.local.get("config");
  const config = item.config || {};
  return {
    llm: { ...DEFAULT_CONFIG.llm, ...(config.llm || {}) },
    supadata: { ...DEFAULT_CONFIG.supadata, ...(config.supadata || {}) },
    feishu: { ...DEFAULT_CONFIG.feishu, ...(config.feishu || {}) },
  };
}

async function getActiveTab(windowId) {
  const query = Number.isInteger(windowId) ? { active: true, windowId } : { active: true, currentWindow: true };
  const [tab] = await chrome.tabs.query(query);
  return tab;
}

// 注入 extractPageContent 到当前页面抓正文
async function extractArticleContent(tab) {
  let res;
  try {
    [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent,
    });
  } catch (e) {
    // 系统页面（chrome:// 等）或无注入权限时 executeScript 会抛错
    throw new Error(
      "无法读取当前页面内容（可能是系统页面，或扩展未获授权）"
    );
  }
  if (!res || !res.result) throw new Error("页面内容提取失败");
  return { ...res.result, tabId: tab.id };
}

async function readPageInfo(tab) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ url: location.href, title: document.title }),
    });
    return { ...res.result, tabId: tab.id };
  } catch (_) {
    if (tab.url && /^https?:/.test(tab.url)) return { url: tab.url, title: tab.title || tab.url, tabId: tab.id };
    throw new Error('无法读取当前页面');
  }
}

// This function is serialized into the page's MAIN world. Same-site page requests
// preserve Bilibili login state without requesting chrome.cookies permission.
async function pageRequest({ url, kind, credentials }) {
  const response = await fetch(url, { credentials });
  const data = kind === 'bytes' ? Array.from(new Uint8Array(await response.arrayBuffer())) : await response.json();
  return { ok: response.ok, status: response.status, data };
}

async function fetchFromTabOrWorker(tabId, url, kind = 'json', options = {}) {
  const credentials = options.credentials || 'omit';
  let result;
  try {
    const [inPage] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: pageRequest, args: [{ url, kind, credentials }],
    });
    result = inPage?.result;
  } catch (_) {
    const response = await fetch(url, { credentials });
    result = {
      ok: response.ok, status: response.status,
      data: kind === 'bytes' ? Array.from(new Uint8Array(await response.arrayBuffer())) : await response.json(),
    };
  }
  if (!result?.ok) throw new Error(`字幕请求失败 (${result?.status || '网络错误'})`);
  return kind === 'bytes' ? new Uint8Array(result.data) : result.data;
}

async function extractCurrentContent(tab, config) {
  const page = await readPageInfo(tab);
  const route = globalThis.CONTENT.detectSource(page.url);
  const info = { ...route, url: page.url, title: page.title };
  if (route.source === 'youtube') {
    return globalThis.YOUTUBE.extract(info,
      async (func) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func }))[0]?.result,
      (url) => fetchFromTabOrWorker(tab.id, url, 'json', { credentials: 'omit' }),
      config.supadata.apiKey);
  }
  if (route.source === 'bilibili') {
    return globalThis.BILIBILI.extract(info, (url, kind, options) => fetchFromTabOrWorker(tab.id, url, kind, options));
  }
  if (route.source === 'x') {
    return globalThis.XPOST.extract(info,
      async (func, postId) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args: [postId] }))[0]?.result,
      config.supadata.apiKey);
  }
  const article = await extractArticleContent(tab);
  if (!article.content?.trim()) throw new Error('当前网页没有可总结的正文');
  return { source: 'article', url: article.url, title: article.title, text: article.content, transcriptKind: 'text' };
}

// 安装时让点击图标直接打开 side panel，并创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});

  chrome.contextMenus.create({
    id: "save-selection",
    title: "保存为段落",
    contexts: ["selection"]
  });
});

// 处理右键菜单 "保存为段落"
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "save-selection") {
    try {
      // 存储数据到 session storage，然后打开对话框
      await chrome.storage.session.set({
        quote_data: {
          selectionText: info.selectionText,
          url: tab.url,
          title: tab.title,
        },
      });

      // 打开对话框窗口
      chrome.windows.create({
        url: chrome.runtime.getURL("src/quote-dialog.html"),
        type: "popup",
        width: 540,
        height: 480,
      });
    } catch (e) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "保存失败",
        message: e.message || "未知错误"
      });
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "GET_CONFIG":
          sendResponse({ ok: true, data: await getConfig() });
          break;

        case "SAVE_CONFIG":
          await chrome.storage.local.set({ config: msg.config });
          sendResponse({ ok: true });
          break;

        case "GET_PROVIDERS":
          sendResponse({ ok: true, data: globalThis.PROVIDERS });
          break;

        case "TEST_LLM": {
          const config = await getConfig();
          if (!config.llm.apiKey) {
            throw new Error("未填写 API Key");
          }
          const r = await globalThis.testLLM(config.llm);
          sendResponse({ ok: true, data: r });
          break;
        }

        case "EXTRACT": {
          const tab = await getActiveTab(msg.windowId);
          if (!tab) throw new Error('找不到当前活动标签页');
          sendResponse({ ok: true, data: await extractCurrentContent(tab, await getConfig()) });
          break;
        }

        case "GET_PAGE_INFO": {
          const tab = await getActiveTab(msg.windowId);
          if (!tab) {
            sendResponse({ ok: false, error: "找不到当前活动标签页" });
            break;
          }
          sendResponse({ ok: true, data: await readPageInfo(tab) });
          break;
        }

        case "GENERATE": {
          const config = await getConfig();
          if (!config.llm.apiKey) {
            throw new Error("未配置 LLM API Key，请到设置页填写");
          }
          const tab = await getActiveTab(msg.windowId);
          if (!tab) throw new Error('找不到当前活动标签页');
          const page = await extractCurrentContent(tab, config);
          const result = await globalThis.summarizeContent(config.llm, page, {
            complexity: msg.complexity || 'standard',
            language: msg.language || 'zh',
          });
          const recordType = page.source === 'youtube' || page.source === 'bilibili' ? '视频' : page.source === 'x' ? '帖子' : '文章';
          sendResponse({
            ok: true,
            data: { ...result, url: page.url, title: page.title, content: page.text, source: page.source,
              transcriptKind: page.transcriptKind, language: page.language || '', recordType, tabId: tab.id },
          });
          break;
        }

        case "SAVE_RECORD": {
          const config = await getConfig();
          const f = config.feishu;
          if (!f.appId || !f.appSecret || !f.appToken || !f.tableId) {
            throw new Error("未配置飞书，请到设置页填写");
          }
          const d = new Date();
          const pad = (n) => String(n).padStart(2, "0");
          const timestamp =
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
            `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          const rec = {
            type: msg.record.type || "文章",
            title: msg.record.title,
            url: msg.record.url,
            summary: msg.record.summary,
            keywords: msg.record.keywords,
            content: msg.record.content,
            notes: msg.record.notes,
            timestamp,
          };
          const r = await globalThis.feishuAppendRecord(f, rec);
          sendResponse({ ok: true, data: r });
          break;
        }

        case "TEST_FEISHU": {
          const config = await getConfig();
          const result = await globalThis.feishuCheckFields(config.feishu);
          sendResponse({ ok: true, data: result });
          break;
        }

        case "SAVE_QUOTE": {
          const config = await getConfig();
          const f = config.feishu;
          if (!f.appId || !f.appSecret || !f.appToken || !f.tableId) {
            throw new Error("未配置飞书，请到设置页填写");
          }
          const d = new Date();
          const pad = (n) => String(n).padStart(2, "0");
          const timestamp =
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
            `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          const rec = {
            type: "段落",
            title: msg.title,
            url: msg.url,
            summary: "",
            keywords: [],
            content: msg.selectionText,
            notes: msg.thoughts,
            timestamp,
          };
          const r = await globalThis.feishuAppendRecord(f, rec);
          sendResponse({ ok: true, data: r });
          break;
        }

        default:
          sendResponse({
            ok: false,
            error: "未知消息类型: " + (msg && msg.type),
          });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // 异步返回
});
