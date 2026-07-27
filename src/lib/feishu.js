// 飞书多维表格 (Bitable) 接入
//
// 由 background.js 通过 importScripts 引入，函数挂到 globalWorld。
// 鉴权：app_id + app_secret 换 tenant_access_token，缓存到 chrome.storage.local。
//
// 对外接口：
//   globalThis.feishuGetToken(config)              -> string (tenant_access_token)
//   globalThis.feishuListFields(config)            -> field[]
//   globalThis.feishuAppendRecord(config, record)  -> { record_id }
//   globalThis.FEISHU_FIELD_KEYS                    字段 key 常量

// 飞书字段名（多维表格列名需与此一致）
globalThis.FEISHU_FIELD_KEYS = {
  title: "标题",
  url: "URL",
  type: "类型",
  summary: "摘要",
  keywords: "关键字",
  content: "原文",
  notes: "感想",
  timestamp: "时间戳",
};

const TOKEN_STORAGE_KEY = "__feishu_token_cache__";
const BASE = "https://open.feishu.cn";

// 读取缓存的 token（带过期判断）
async function getCachedToken() {
  const item = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  const cache = item[TOKEN_STORAGE_KEY];
  if (!cache) return null;
  // 提前 60 秒认为过期，避免边界
  if (!cache.expireAt || cache.expireAt - 60000 < Date.now()) return null;
  return cache.token;
}

async function setCachedToken(token, expireSec) {
  const cache = {
    token,
    expireAt: Date.now() + expireSec * 1000,
  };
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: cache });
}

async function clearCachedToken() {
  await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
}

// 用 app_id/app_secret 换 tenant_access_token
async function fetchTenantToken(config) {
  const resp = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret,
    }),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`飞书鉴权失败: ${data.msg} (code ${data.code})`);
  }
  return { token: data.tenant_access_token, expire: data.expire };
}

globalThis.feishuGetToken = async function feishuGetToken(config) {
  const cached = await getCachedToken();
  if (cached) return cached;
  const { token, expire } = await fetchTenantToken(config);
  await setCachedToken(token, expire);
  return token;
};

// 遇到 401/99991663 等鉴权失效时，清缓存重试一次
async function withTokenRetry(config, fn) {
  let token = await globalThis.feishuGetToken(config);
  let resp = await fn(token);
  if (resp.status === 401 || resp.status === 403) {
    await clearCachedToken();
    token = await globalThis.feishuGetToken(config);
    resp = await fn(token);
  }
  return resp;
}

// 列出表字段（用于「测试连接」并提示缺哪些列）
globalThis.feishuListFields = async function feishuListFields(config) {
  const resp = await withTokenRetry(config, (token) =>
    fetch(
      `${BASE}/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/fields`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }
    )
  );
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`飞书获取字段失败: ${data.msg} (code ${data.code})`);
  }
  return (data.data && data.data.items) || [];
};

// 追加一条记录
// record: { title, url, summary, keywords[], content, notes, timestamp }
globalThis.feishuAppendRecord = async function feishuAppendRecord(config, record) {
  const fields = {
    [globalThis.FEISHU_FIELD_KEYS.title]: record.title || "",
    [globalThis.FEISHU_FIELD_KEYS.url]: record.url || "",
    [globalThis.FEISHU_FIELD_KEYS.type]: record.type || "文章",
    [globalThis.FEISHU_FIELD_KEYS.summary]: record.summary || "",
    [globalThis.FEISHU_FIELD_KEYS.keywords]: (record.keywords || []).join("; "),
    [globalThis.FEISHU_FIELD_KEYS.content]: record.content || "",
    [globalThis.FEISHU_FIELD_KEYS.notes]: record.notes || "",
    [globalThis.FEISHU_FIELD_KEYS.timestamp]: record.timestamp || "",
  };

  const resp = await withTokenRetry(config, (token) =>
    fetch(
      `${BASE}/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ fields }),
      }
    )
  );
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`飞书写入失败: ${data.msg} (code ${data.code})`);
  }
  return { record_id: data.data && data.data.record && data.data.record.record_id };
};

// 检查必需字段是否齐全
// 返回 { missing, suggestions, existing }
// - missing: 飞书表里完全不存在的列
// - suggestions: 列名存在但含空格/不可见字符的差异提示（去空白后能匹配上）
// - existing: 飞书表里实际的全部列名（用于调试对比）
globalThis.feishuCheckFields = async function feishuCheckFields(config) {
  const fields = await globalThis.feishuListFields(config);
  const existing = fields.map((f) => f.field_name);
  const existingSet = new Set(existing);
  const required = Object.values(globalThis.FEISHU_FIELD_KEYS);
  const missing = [];
  const suggestions = [];
  for (const req of required) {
    if (existingSet.has(req)) continue;
    const norm = (s) => s.replace(/\s+/g, "");
    const fuzzy = existing.find((e) => norm(e) === norm(req));
    if (fuzzy) {
      suggestions.push(
        `「${req}」实际在飞书表里叫「${fuzzy}」(可能含空格或不可见字符),请将代码或飞书列名对齐`
      );
    } else {
      missing.push(req);
    }
  }
  return { missing, suggestions, existing };
};
