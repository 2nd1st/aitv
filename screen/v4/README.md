# 第四版画面（?ui=v4）

来自艾维的分支 `screen-v4` @ 4d2e80b（`screen/tv.js`、`screen/tv.css` 原样拷过来），`aitv.qiaomu.ai/?ui=v4` 用这一版，不带参数仍是 `/screen/`。

沃兹在拷贝里改了一处（2026-10-09），给艾维合回分支时参考：
- stale 条目的「N 小时前」：`publishedAt` / `rankedAt` 是毫秒数（不是字符串），不能 `Date.parse`；榜单类（`dateKind: "ranked"`，PH / GitHub）按 `rankedAt` 算，其余按 `publishedAt`。
- 静音时的第一下：在 picture 上加了捕获阶段的 click 处理，点哪儿（包括标题 / 看原文链接）都先出声，这一下 `preventDefault` 不跳转；出声之后链接照常。
