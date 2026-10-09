# AI 今天 · aitv.qiaomu.ai

一个台，像真电视。浏览器按「音频 + 时间轴」实时渲染，不渲染真视频。

## 结构
- `src/worker.js`：`/api/time` 校时（毫秒）、`/api/schedule` 节目单；定时任务每 15 分钟出一份新节目单，失败保留上一份。
- `src/schedule.js`：节目单连续排、无空档，缺音频的条目跳过，播完循环。
- `src/validate.js`：数字硬校验。稿子只能用 `{{字段}}` 引用源数据，渲染后出现源数据里没有的数字，整条丢掉。
- `src/sources.js`：抓榜（包打听）。HN、GitHub Trending、Product Hunt、AIHOT 四个源，出统一 item（`id`、`source`、`url`、`fetchedAt`、`publishedAt`、`template`、`focus`、`fields`），数字原样放在 `fields`。一个源挂了只记进 `errors`，其他源照常出；`dedupe` 按 id 跨轮去重，`interleave` 让四个源轮流排。本地试抓：`node scripts/fetch-sources.mjs`。
- `src/enrich.js`：补料（包打听）。每条去读原文页、README 或产品页，交给写稿模型提炼 `what`（是什么）、`who`（给谁用）、`highlight`（亮点）。这三个字段里不许有任何数字（常用词白名单除外），不合格 `brief` 为 null。模型通过 `enrich(item, { llm })` 注入。本地看命中率：`node scripts/try-enrich.mjs`。
- `src/digits.js`：数字规则唯一出处（白名单：一个、一款、一种、一句话、一下、一起、一些、一直、一样、唯一、统一、万一、十分；先去白名单再查阿拉伯数字/中文数字）。`enrich.js` 和 `validate.js` 共用。
- `src/writer.js`：写稿 v3。DeepSeek 只看 brief（kind / name / what / who / highlight）+ 标题 + 带单位的数字字段，写三段：这是什么 / 跟你有什么关系 / AI 点评。`kind` 由补料定（product / project / commentary / news），写稿只读不改：只有 product / project 的点评可以是「今天就可以试」；commentary / news 讲清主张或报道和立场，点评是判断或接下来该看什么。part1 必须点名，带数字的名字只能经 `{{name}}`（补料从标题原样摘出、已核实）进稿。语气中性专业，`src/tone.js` 拦「抄」「破解」「绕过」这类说法；禁「值得关注」「值得一看」等空话；相邻两条点评开头不能一样。输出模板，`validate.js` 校验，不过重写一次，再不过丢掉。原文不进 seed、不进节目单（只留 brief + url）。
- `src/validate.js` 的 `UNITS`：每个能进稿的数字字段都注明它在源接口里是什么数；含义没核实的不留（HN / Product Hunt 不给 rank，AIHOT 的 sourceCount / signalCount 没文档，不用）。
- 生成节目（新版本，不影响线上）：`node scripts/build-items.mjs 20 > /tmp/items.json && /workspace/podcast/.venv/bin/python scripts/tts_seed.py /tmp/items.json [版本号]` → `public/seeds/<版本号>/seed.json` + `audio/`（需要 `DEEPSEEK_API_KEY`、`DOUBAO_TTS_ACCESS_TOKEN`；写稿模型默认 `deepseek-v4-pro`，补料默认 `deepseek-chat`，可用 `AITV_SCRIPT_MODEL` / `AITV_BRIEF_MODEL` 改）。版本号是东八区时间，如 `20261009-1130`。

### 发布与回滚

- **音频在 R2**（桶 `aitv-audio`，Worker 绑定 `env.AUDIO`），key 是 `<版本号>/<文件>.mp3`，Worker 在 `/audio/<版本号>/<文件>.mp3` 上直接读 R2：带 `Range` 回 206（`Content-Range`、`Content-Length` 准确），不带回 200；都带 `Accept-Ranges: bytes`、`ETag`、长缓存（`If-None-Match` 命中回 304）。`public/` 里不再放 mp3。
- **节目单在 KV**（命名空间绑定 `SCHEDULE`）：`seed:<版本号>` 是整份节目单，`pointer` 是 `{ "version": 线上版本, "previous": 上一版 }`。`/api/schedule` 读指针对应的 seed，返回里带 `version`。播放器每分钟查一次，版本变了自动接上，不用刷新。
- 本地 `releases/<版本号>/seed.json` 进 git；`releases/<版本号>/audio/` 只在本机（.gitignore），线上以 R2 为准。
- 新版本：`scripts/tts_seed.py items.json <版本号>` 生成到 `releases/<版本号>/` → `node scripts/release.mjs publish <版本号>`（校验后把音频传 R2、seed 写 KV，**不切换**）→ `node scripts/release.mjs use <版本号>`（再校验一遍，并逐条 HEAD 线上 `/audio/…` 确认 200 + audio/mpeg + 长度一致；**可播少于 15 条就不切**；通过后一步改 KV 指针）。不需要重新部署 Worker。
- **回滚**（KV 指针切回上一版，旧版本的 R2 音频和 KV seed 都还在；不用部署，KV 全球生效约 60 秒）：
  ```sh
  cd /workspace/aitv && source /home/box/.cf_aitv.env && node scripts/release.mjs rollback
  ```
  代码出问题（而不是节目单）时回到上一次 Worker 部署：`source /home/box/.cf_aitv.env && npx wrangler rollback`。
- 其他：`node scripts/release.mjs list`（本地版本 + 线上指针）、`check <版本号>`（只校验本地）。
- `public/app.js` 播放器：标题/来源点开原文（新标签页）；点画面暂停、再点从暂停处继续；暂停或落后直播时显示「回到直播」，按服务器时钟重新定位；字幕显示正在念的那段。进来/回到直播时等音频 `loadedmetadata`（再在 `canplay` 校一次）按那一刻的服务器时间设 `currentTime`；播放中偏差超过 0.25 秒且缓冲够了才拉回；每分钟重新校时。
- `screen/`：画面，艾维负责，只暴露 `render(item, t)`。
- `public/`：静态页。

## item 契约（screen 只认这些）
```json
{
  "id": "hn-41234567",
  "template": "title | number | source",
  "start": 1760000000000,
  "duration": 38.2,
  "audio": "/audio/20261009-1133/hn-41234567.mp3",
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
