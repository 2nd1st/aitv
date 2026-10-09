# screen/ · 电视这一屏（第二版）

```js
import { createTV } from "/screen/tv.js";
const tv = createTV(root, {
  onPower: (booting) => {},     // 在这次点击里起播音频，开机雪花约 600ms
  onScreenClick: () => {},      // 点画面：播放层决定暂停或继续
  onGoLive: () => {},           // 点「回到直播」：按服务器时间重新定位
});
tv.render(item, t, nowMs, ctx); // 每帧调用
tv.setPaused(true | false);     // 暂停态的画面：「已暂停」+「回到直播」按钮
```

`ctx`（都可以不传，默认是背景直播）：
- `mode`：`"live"` 背景直播 | `"program"` 准点节目
- `episode`：节目名，比如 `"早间 · 10月9日"`
- `index` / `count`：本期第几条、一共几条，用来画顶部的目录条
- `upcoming`：`[{ title, source }]`，用在底部滚动条（直播时显示「接下来」，节目时显示「本期」）

画面里读的 item 字段：
- `fields.what` / `fields.who`：「是什么」「跟你有关」。
- `take`（或 `fields.take`）：一句点评，模型写的，画面上标「AI 点评」（不署人名）。没有点评时用 `fields.highlight`，显示为「亮点」。
- `fields.title_zh`：中文标题，有的话大字显示中文，原标题以小字显示在下面。
- `rounds[i].part`：`"what"`、`"who"`、`"take"`。念到哪段，哪段就亮，后面的段还没出现。不填的话按时长平均分。
- 数字只从 `fields` 读，做成角标（名次、分、评论、星、票），不做正文。
- 没有 what/who 的旧条目照旧走 `title` / `number` / `source` 模板。
- `template: "caughtup"`：节目结束时显示「已追平」卡，读 `fields.title` 和 `fields.note`。

标题和「看原文」都能点，点了会在新标签页打开原文，不会触发暂停。

预览（示例数据）：在仓库根目录起一个静态服务，打开 `/screen/preview.html`。
`?on=1&mode=program&i=1&t=9` 用来定格到某一帧，`&paused=1` 看暂停态。
