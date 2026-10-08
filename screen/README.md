# screen/ · 电视这一屏

```js
import { createTV } from "/screen/tv.js";
const tv = createTV(document.getElementById("root"), {
  onPower: (booting) => { /* 在这次点击里起播音频；booting 是开机雪花的 Promise，约 600ms */ },
});
// 每帧：t = 这一条已经播了几秒，nowMs = 校准后的服务器时间
tv.render(item, t, nowMs);
```

- 画面只由 `(item, t)` 决定，两台设备 t 相同，画面相同。
- `template`：`title` / `number` / `source`。
- 数字卡只读 `fields`。用哪个字段看 `item.focus`；没有就取 `fields` 里第一个数字。数到源值后停在精确值上，不取整、不换成「万」。
- 标题卡的高亮词来自 `rounds[i].keyword`（可选），正在念第几句就亮第几个；没有 keyword 就不显示这一行。
- 换条前 0.22 秒是雪花，按 t 算。
- 「看原文」在下方常驻，来源卡上的网址也能点。
- 预览（示例数据）：在仓库根目录起一个静态服务，打开 `/screen/preview.html`。`?on=1&i=1&t=3` 可以定格到某一帧。
- 上线时把 `screen/` 放进 `public/` 或在构建时拷过去，静态资源目录是 `public`。
