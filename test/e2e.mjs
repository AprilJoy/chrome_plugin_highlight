// 端到端冒烟测试：加载扩展 -> options 配置 -> side panel UI 状态联动
// 用法: node test/e2e.mjs
// HEADLESS=1 时使用 Playwright 自带 Chromium 加载未打包扩展。
import { chromium } from "playwright";
import path from "path";
import os from "os";
import fs from "fs";
import { fileURLToPath } from "url";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-ext-"));
const SHOT_DIR = path.join(tmpDir, "shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(tmpDir, {
  channel: process.env.HEADLESS === "1" ? "chromium" : undefined,
  headless: process.env.HEADLESS === "1",
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

let failures = 0;
const assert = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

try {
  // 拿扩展 id（从 service worker），MV3 SW 可能懒启动，等久一点
  let sw = ctx.serviceWorkers().find((w) => w.url().includes("chrome-extension"));
  if (!sw) {
    try {
      sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
    } catch (e) {
      // 兜底：打开一个标签触发扩展，再查
      const trigger = await ctx.newPage();
      await trigger.goto("about:blank").catch(() => {});
      await trigger.waitForTimeout(2000);
      sw = ctx.serviceWorkers().find((w) => w.url().includes("chrome-extension"));
    }
  }
  if (!sw) {
    // 截图 chrome://extensions 便于排查
    const ext = await ctx.newPage();
    await ext.goto("chrome://extensions");
    await ext.waitForTimeout(1500);
    await ext.screenshot({ path: path.join(SHOT_DIR, "extensions-page.png") });
    console.log("service workers:", ctx.serviceWorkers().map((w) => w.url()));
    throw new Error("未拿到扩展 service worker（见 shots/extensions-page.png）");
  }
  const id = sw.url().split("/")[2];
  console.log("extension id:", id);
  assert("扩展已加载（拿到 service worker）", !!id);

  // ---- options 页 ----
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${id}/src/options.html`);
  await opt.waitForLoadState("domcontentloaded");

  assert("options: LLM 测试连接按钮存在", !!(await opt.$("#testLlm")));
  assert("options: 飞书测试连接按钮存在", !!(await opt.$("#test")));
  assert("options: 可选 Supadata Key 字段存在", !!(await opt.$("#supadataKey")));
  assert("options: 厂商下拉有智谱", (await opt.$eval("#provider", (s) => Array.from(s.options).map((o) => o.value))).includes("zhipu"));

  // 填 DeepSeek 假 key 保存
  await opt.selectOption("#provider", "deepseek");
  await opt.fill("#apiKey", "sk-fake-key-for-test");
  await opt.fill("#supadataKey", "supadata-fake-key-for-test");
  await opt.click("#save");
  await opt.waitForTimeout(400);
  const saveText = await opt.$eval("#saveResult", (el) => el.textContent);
  assert("options: 保存成功提示", /已保存/.test(saveText));

  // 验证 storage 真的写进去了
  const stored = await opt.evaluate(async () => {
    const r = await chrome.storage.local.get("config");
    return r.config;
  });
  assert("storage: config.llm.apiKey 已写入", stored && stored.llm && stored.llm.apiKey === "sk-fake-key-for-test");
  assert("storage: 可选 Supadata Key 已写入", stored?.supadata?.apiKey === "supadata-fake-key-for-test");

  await opt.screenshot({ path: path.join(SHOT_DIR, "options.png") });

  // ---- side panel 页 ----
  const sp = await ctx.newPage();
  await sp.goto(`chrome-extension://${id}/src/sidepanel.html`);
  await sp.waitForLoadState("domcontentloaded");
  await sp.waitForTimeout(500); // 等 refreshConfigState / loadCurrentPage

  // 配了 key 后生成按钮应可用；飞书未配保存按钮应禁用
  const genDisabled = await sp.isDisabled("#generate");
  const saveDisabled = await sp.isDisabled("#save");
  assert("sidepanel: 配置 key 后生成按钮可用", !genDisabled);
  assert("sidepanel: 飞书未配置时保存按钮禁用", saveDisabled);
  assert("sidepanel: 来源标识存在", !!(await sp.$("#source")));

  await opt.evaluate(async () => {
    const { config } = await chrome.storage.local.get("config");
    config.feishu = { appId: "fake-id", appSecret: "fake-secret", appToken: "fake-token", tableId: "fake-table" };
    await chrome.storage.local.set({ config });
  });
  await sp.waitForFunction(() => document.getElementById("status").textContent.includes("先生成摘要"));
  assert("sidepanel: 飞书已配置但尚无摘要时显示正确提示", await sp.isDisabled("#save"));

  await sp.screenshot({ path: path.join(SHOT_DIR, "sidepanel.png") });

  // 点生成 -> 因 key 假，应走入错误路径并提示
  await sp.click("#generate");
  await sp.waitForFunction(
    () => {
      const t = document.getElementById("status").textContent;
      return t && t.length > 0 && !/正在/.test(t);
    },
    { timeout: 15000 }
  );
  const status = await sp.$eval("#status", (el) => el.textContent);
  console.log("sidepanel: 点生成后状态:", status);
  assert("sidepanel: 假 key 下生成返回错误提示", /失败/.test(status));

  // 在完整浏览器里验证 YouTube 页面主世界探测、字幕请求、LLM 编排。
  const videoId = "abc123XYZ00";
  await ctx.route(`https://www.youtube.com/watch?v=${videoId}`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<title>测试视频</title><div id="movie_player"></div><script>
      document.querySelector('#movie_player').getPlayerResponse = () => ({
        videoDetails: { videoId: '${videoId}', title: '测试视频' },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=${videoId}&lang=zh', languageCode: 'zh' }] } }
      });
    </script>`,
  }));
  await ctx.route("https://www.youtube.com/api/timedtext**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "字幕真实内容" }] }] }),
  }));
  await ctx.route("https://api.deepseek.com/**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ choices: [{ message: { content: '{"summary":"视频摘要","keywords":["字幕"]}' } }] }),
  }));
  const yt = await ctx.newPage();
  await yt.goto(`https://www.youtube.com/watch?v=${videoId}`);
  await yt.bringToFront();
  const windowId = await opt.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const generated = await opt.evaluate((id) => new Promise((resolve) => chrome.runtime.sendMessage({ type: "GENERATE", windowId: id }, resolve)), windowId);
  assert("YouTube: 从字幕生成摘要", generated?.ok && generated.data.summary === "视频摘要");
  assert("YouTube: 原文是字幕而非播放器页面", generated?.data?.content?.includes("字幕真实内容") && generated.data.recordType === "视频");
  await sp.evaluate(() => onGenerate());
  await sp.evaluate(() => { document.getElementById("notes").value = "保留的感想"; });
  await yt.evaluate(() => { document.title = "只改标题"; });
  await sp.waitForTimeout(250);
  const kept = await sp.evaluate(() => [document.getElementById("summary").value, document.getElementById("notes").value]);
  assert("sidepanel: 只改标题时保留摘要与感想", kept[0] === "视频摘要" && kept[1] === "保留的感想");
  const other = await ctx.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await sp.waitForFunction(() => document.getElementById("summary").value === "", undefined, { timeout: 5000 });
  assert("sidepanel: 切换标签时清稿并禁用保存", await sp.isDisabled("#save") && await sp.inputValue("#notes") === "");
  await yt.bringToFront();
  await sp.evaluate(() => onGenerate());
  await sp.waitForFunction(() => document.getElementById("summary").value === "视频摘要", undefined, { timeout: 5000 });
  await sp.evaluate(() => { document.getElementById("notes").value = "新感想"; });
  await ctx.route("https://www.youtube.com/watch?v=diff123XYZ0", (route) => route.fulfill({ contentType: "text/html", body: "<title>另一个视频</title>" }));
  await yt.goto("https://www.youtube.com/watch?v=diff123XYZ0");
  await sp.waitForFunction(() => document.getElementById("summary").value === "", undefined, { timeout: 5000 });
  const cleared = await sp.evaluate(() => ({ summary: document.getElementById("summary").value, content: document.getElementById("content").value, notes: document.getElementById("notes").value, saveDisabled: document.getElementById("save").disabled }));
  assert("sidepanel: URL 变化清稿并禁用保存", !cleared.summary && !cleared.content && !cleared.notes && cleared.saveDisabled);

  await ctx.route("https://x.com/alice/status/12345", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<meta charset="utf-8"><title>X 测试帖</title><article data-testid="tweet"><a href="/alice/status/12345"><time>今天</time></a><div data-testid="tweetText">主帖应被总结</div></article><article data-testid="tweet"><a href="/bob/status/67890"><time>今天</time></a><div data-testid="tweetText">回复不得混入</div></article>`,
  }));
  const xp = await ctx.newPage();
  await xp.goto("https://x.com/alice/status/12345");
  await xp.bringToFront();
  const xResult = await opt.evaluate((id) => new Promise((resolve) => chrome.runtime.sendMessage({ type: "GENERATE", windowId: id }, resolve)), windowId);
  if (!xResult?.ok || xResult.data.content !== "主帖应被总结") console.log("X 调试结果:", JSON.stringify(xResult));
  assert("X: 只提取当前主帖", xResult?.ok && xResult.data.content === "主帖应被总结" && xResult.data.recordType === "帖子");

  const bvid = "BV1BbKw6XEWq";
  const biliHeaders = { "access-control-allow-origin": "https://www.bilibili.com", "access-control-allow-credentials": "true" };
  const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n >>>= 7; } out.push(n); return out; };
  const field = (n, data) => [...varint(n * 8 + 2), ...varint(data.length), ...data];
  const aiUrl = "https://aisubtitle.hdslb.com/test.json";
  const encode = (s) => [...new TextEncoder().encode(s)];
  const track = [...field(3, encode("ai-zh")), ...field(4, encode("中文 AI")), ...field(5, encode(aiUrl))];
  const proto = Buffer.from(field(1, field(3, track)));
  await ctx.route(`https://www.bilibili.com/video/${bvid}?p=1`, (route) => route.fulfill({ contentType: "text/html", body: "<title>B 站测试视频</title>" }));
  await ctx.route("https://api.bilibili.com/x/web-interface/view?*", (route) => route.fulfill({ headers: biliHeaders, contentType: "application/json", body: JSON.stringify({ code: 0, data: { aid: 1, cid: 2, bvid, title: "B 站测试视频", pages: [{ cid: 2, part: "第 1 P" }] } }) }));
  await ctx.route("https://api.bilibili.com/x/player/v2?*", (route) => route.fulfill({ headers: biliHeaders, contentType: "application/json", body: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }) }));
  await ctx.route("https://api.bilibili.com/x/v2/subtitle/web/view?*", (route) => route.fulfill({ headers: biliHeaders, contentType: "application/octet-stream", body: proto }));
  await ctx.route(aiUrl, (route) => route.fulfill({ headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ body: [{ from: 1.5, to: 2.5, content: "B 站 AI 字幕内容" }] }) }));
  const bp = await ctx.newPage();
  await bp.goto(`https://www.bilibili.com/video/${bvid}?p=1`);
  await bp.bringToFront();
  const bResult = await opt.evaluate((id) => new Promise((resolve) => chrome.runtime.sendMessage({ type: "GENERATE", windowId: id }, resolve)), windowId);
  assert("B 站: 旧接口空时解析 Protobuf AI 字幕", bResult?.ok && bResult.data.content.includes("B 站 AI 字幕内容") && bResult.data.language === "ai-zh");
} catch (e) {
  console.error("测试异常:", e.message);
  failures++;
} finally {
  await ctx.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n结果: ${failures === 0 ? "全部通过 ✅" : failures + " 项失败 ❌"}`);
  process.exit(failures === 0 ? 0 : 1);
}
