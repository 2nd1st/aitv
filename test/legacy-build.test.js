import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 兼容版给 Chrome 61 的系统 WebView 用：这些写法老内核直接 SyntaxError，整页白屏
test("legacy build: 产物里没有 Chrome 61 不认的语法", () => {
  execFileSync(process.execPath, ["scripts/build-legacy.mjs"], { stdio: "pipe" });
  const js = readFileSync("public/legacy/app.js", "utf8");
  for (const [name, re] of [
    ["optional chaining", /\?\.[A-Za-z_$(\[]/],
    ["nullish coalescing", /\?\?/],
    ["logical assignment", /(\|\||&&|\?\?)=/],
    ["dynamic import", /\bimport\(/],
    ["ES module syntax", /^\s*(import|export)\s/m],
    ["cqw 单位", /\dcqw/],
  ]) assert.ok(!re.test(js), `public/legacy/app.js 里有 ${name}`);
  assert.match(js, /AbortSignal/, "polyfill 没打进去");
  assert.match(js, /--cqw/, "shim 没打进去");
});

test("legacy build: /legacy/ 自包含（样式和脚本都在目录里）", () => {
  const html = readFileSync("public/legacy/index.html", "utf8");
  for (const ref of html.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
    if (ref[1] === "/icon.svg") continue;
    assert.ok(ref[1].startsWith("/legacy/"), `index.html 引用了 /legacy/ 以外的文件：${ref[1]}`);
    readFileSync("public" + ref[1]);
  }
});
