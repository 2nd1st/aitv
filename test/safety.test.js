import { test } from "node:test";
import assert from "node:assert/strict";
import { safetyKeywordHits, checkSafety } from "../src/safety.js";
import { enrich, briefPrompt } from "../src/enrich.js";

const gh = (title, description) => ({ id: "gh-x", source: "GitHub Trending", url: "https://github.com/a/b", fields: { title, description } });

test("关键词兜底：盗版 / 主机可执行文件与 ROM / 绕过 DRM·反作弊·付费墙 / 破解 / 克隆 都拦", () => {
  assert.ok(checkSafety(gh("boykopovar / AnyPS5", "Tool for automatic PS5 executables porting to Linux and Windows")).reasons.join().includes("console-executables"));
  const bad = [
    "Switch emulator that runs commercial games on Android",
    "Download game ROMs for every console",
    "Bypass the Denuvo DRM in one click",
    "Disable anti-cheat to run mods in online games",
    "Chrome extension to bypass paywalls on news sites",
    "Remove paywall from any article",
    "Office keygen and cracked installer",
    "破解版专业软件合集",
    "一个绕过付费墙的浏览器插件",
    "盗版电影资源站",
    "A pixel-perfect clone of Notion for your team",
    "一比一复刻某大厂 App 的界面",
  ];
  for (const t of bad) assert.ok(safetyKeywordHits(t).length > 0, t);
});

test("关键词兜底不误伤正常内容", () => {
  const ok = [
    "Sony raises PS5 price in Europe",
    "Anthropic releases Sonnet 5.5 and Haiku 5.5 with lower prices",
    "A graphical debugger for native Windows x64 programs",
    "We cracked down on spam with a new classifier",
    "Rust port of the SQLite query planner",
    "Nintendo reports record Switch sales",
    "Paywalled journalism and the future of news",
    "我请插画师画了房子，现在成了我的 Home Assistant 面板",
  ];
  for (const t of ok) assert.deepEqual(safetyKeywordHits(t), [], t);
});

const html = "<html><title>x</title><body>" + "素材正文".repeat(100) + "</body></html>";
const fetchImpl = async () => ({ ok: true, url: "https://a.test/", text: async () => html });

test("enrich：模型标记 unsafe 的整条丢掉；关键词命中的连模型都不调", async () => {
  const llm = async () => JSON.stringify({ safety: "unsafe", safetyReason: "教人绕过付费墙", kind: "product", what: "一个插件", who: "读者", highlight: "更快" });
  const r = await enrich({ id: "a", source: "Product Hunt", url: "https://a.test/", fields: { title: "ReadAll", tagline: "Read any article" } }, { llm, fetchImpl });
  assert.equal(r.brief, null); assert.equal(r.unsafe, true); assert.match(r.briefError, /内容安全：模型标记 unsafe：教人绕过付费墙/);
  let called = 0;
  const r2 = await enrich(gh("boykopovar / AnyPS5", "Tool for automatic PS5 executables porting to Linux and Windows"), { llm: async () => (called++, "{}"), fetchImpl: async () => (called++, null) });
  assert.equal(r2.brief, null); assert.equal(r2.unsafe, true); assert.equal(called, 0);
  // 模型说 ok、但 brief 文本命中关键词：照样拦
  const llm3 = async () => JSON.stringify({ safety: "ok", kind: "project", what: "能把主机游戏的可执行文件移植到电脑上", who: "玩家", highlight: "不用模拟器" });
  const r3 = await enrich(gh("foo / bar", "A tool"), { llm: llm3, fetchImpl });
  assert.equal(r3.brief, null); assert.match(r3.briefError, /console-executables/);
  // 正常条目照常通过
  const llm4 = async () => JSON.stringify({ safety: "ok", safetyReason: "", kind: "project", what: "画图技能", who: "开发者", highlight: "风格统一" });
  assert.ok((await enrich(gh("foo / bar", "Diagram skill"), { llm: llm4, fetchImpl })).brief);
  assert.match(briefPrompt({ fields: { title: "x" }, source: "AIHOT" }, { text: "y" }), /safety：先判断这条的主要用途/);
});
