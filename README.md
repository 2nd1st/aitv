# AI 今天 · aitv.qiaomu.ai

一个台，像真电视。浏览器按「音频 + 时间轴」实时渲染，不渲染真视频。

## 结构
- `src/worker.js`：`/api/time` 校时（毫秒）、`/api/schedule` 节目单；定时任务每 15 分钟出一份新节目单，失败保留上一份。
- `src/schedule.js`：节目单连续排、无空档，缺音频的条目跳过，播完循环。
- `src/validate.js`：数字硬校验。稿子只能用 `{{字段}}` 引用源数据，渲染后出现源数据里没有的数字，整条丢掉。
- `src/sources.js`：抓榜（包打听）。HN、GitHub Trending、Product Hunt、AIHOT 四个源，出统一 item（`id`、`source`、`url`、`fetchedAt`、`publishedAt`、`template`、`focus`、`fields`），数字原样放在 `fields`。一个源挂了只记进 `errors`，其他源照常出；`dedupe` 按 id 跨轮去重，`interleave` 让四个源轮流排。本地试抓：`node scripts/fetch-sources.mjs`。
- `src/enrich.js`：补料（包打听）。每条去读原文页、README 或产品页，交给写稿模型提炼 `what`（是什么）、`who`（给谁用）、`highlight`（亮点）。这三个字段里不许有任何数字（常用词白名单除外），不合格 `brief` 为 null。模型通过 `enrich(item, { llm })` 注入。本地看命中率：`node scripts/try-enrich.mjs`。
- `src/digits.js`：数字规则唯一出处（白名单：一个、一款、一种、一句话、一下、一起、一些、一直、一样、唯一、统一、万一、十分；先去白名单再查阿拉伯数字/中文数字）。`enrich.js` 和 `validate.js` 共用。
- `src/writer.js`：写稿 v2。DeepSeek 只看 brief（what/who/highlight）+ 标题 + 带单位的数字字段，写三段：这是什么 / 跟你有什么关系 / 一句可执行的点评（禁「值得关注」「值得一看」这类空话）。输出模板，`validate.js` 校验，不过重写一次，再不过丢掉。原文不进 seed、不进节目单（只留 brief + url）。
- 生成节目：`node scripts/build-items.mjs 20 > /tmp/items.json && /workspace/podcast/.venv/bin/python scripts/tts_seed.py /tmp/items.json`（需要 `DEEPSEEK_API_KEY`、`DOUBAO_TTS_ACCESS_TOKEN`；写稿模型默认 `deepseek-v4-pro`，补料默认 `deepseek-chat`，可用 `AITV_SCRIPT_MODEL` / `AITV_BRIEF_MODEL` 改）。
- `public/app.js` 播放器：标题/来源点开原文（新标签页）；点画面暂停、再点从暂停处继续；暂停或落后直播时显示「回到直播」，按服务器时钟重新定位；字幕显示正在念的那段。
- `screen/`：画面，艾维负责，只暴露 `render(item, t)`。
- `public/`：静态页。

## item 契约（screen 只认这些）
```json
{
  "id": "hn-41234567",
  "template": "title | number | source",
  "start": 1760000000000,
  "duration": 38.2,
  "audio": "/audio/hn-41234567.mp3",
  "url": "https://原文链接",
  "source": "Hacker News",
  "fields": { "title": "...", "points": 812, "comments": 233 },
  "spoken": "渲染并通过校验后的口播稿",
  "rounds": [{ "text": "...", "start_time": 0, "end_time": 4.03 }]
}
```
`t` = 这一条已经播了几秒（由校准后的服务器时间算出）。两台设备 t 相同，画面相同。数字卡只读 `fields`，不读 `spoken`。

## 本地
```bash
npm test
npm run dev
```
