// 端到端冒烟测试：加载扩展 -> options 配置 -> side panel UI 状态联动
// 用法: node test/e2e.mjs
// 注意：加载未打包扩展必须 headed（会弹 Chrome 窗口）
import { chromium } from "playwright";
import path from "path";
import os from "os";
import fs from "fs";

const EXT = "/Users/shaoyang/Test/chrome_plugin_highlight";
const SHOT_DIR = path.join(EXT, "test", "shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-ext-"));

const ctx = await chromium.launchPersistentContext(tmpDir, {
  headless: false,
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
  assert("options: 厂商下拉有智谱", (await opt.$eval("#provider", (s) => Array.from(s.options).map((o) => o.value))).includes("zhipu"));

  // 填 DeepSeek 假 key 保存
  await opt.selectOption("#provider", "deepseek");
  await opt.fill("#apiKey", "sk-fake-key-for-test");
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
} catch (e) {
  console.error("测试异常:", e.message);
  failures++;
} finally {
  await ctx.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n结果: ${failures === 0 ? "全部通过 ✅" : failures + " 项失败 ❌"}`);
  process.exit(failures === 0 ? 0 : 1);
}
