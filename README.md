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

### 部署（唯一入口）

```sh
cd /workspace/aitv-main && source /home/box/.cf_aitv.env && npm run deploy
```
`scripts/deploy.mjs` 先过闸门（`scripts/guard.mjs`）：当前分支必须是 `main`、工作区干净（含未跟踪文件）、`git fetch` 后 `HEAD == origin/main`，否则拒绝。通过后构建并 `wrangler deploy --define BUILD_COMMIT:"<sha>"`，`/api/schedule` 返回的 `commit` 就是线上 Worker 的提交。`release.mjs publish / use` 走同一个闸门，`use` 把当前提交记进 KV 指针（`/api/schedule` 的 `releaseCommit`）；`rollback` 只换指针、应急用，不设闸。不要直接 `npx wrangler deploy`，也不要在共享的 `/workspace/aitv`（设计师在那里切分支）部署。

### 内容规则（补料这一步）
- 内容安全（`src/safety.js`）：主要用途是盗版、在原平台以外运行主机 / 游戏可执行文件或 ROM、绕过 DRM / 反作弊 / 付费墙、破解、克隆别人产品的条目，在补料时整条丢掉。模型在 brief 里给 `safety: ok|unsafe`，再加标题 / 源站简介 / brief 文本的关键词兜底；标题和简介命中的连原文都不读。
- 数字规则（`src/digits.js`）：白名单收词标准——一个词里的数字既不表示数量、也不表示名次或先后时才能收（`同一`、`一致` 可以；`第一次` 不行，提示词要求换成不带先后的说法，除非原文明说）。大写数字不查。

### 发布与回滚

- **音频在 R2**（桶 `aitv-audio`，Worker 绑定 `env.AUDIO`），**按内容寻址**：key 是 `<hash>.mp3`，hash = sha256(两个音色 + 合成参数 + 三段口播稿) 的前 16 位，旁边 `<hash>.json` 存分句时间轴（不对外）。同一份稿子不重复合成（`tts_seed.py` 先看本地 `audio-cache/`，再看 R2，有就跳过 TTS），跨版本共用，定时任务重跑也不重复花钱。最早两个版本（20261009-1057 / 1133）用的是 `<版本号>/<文件>.mp3`，Worker 照样认。Worker 在 `/audio/<hash>.mp3` 上直接读 R2：带 `Range` 回 206（`Content-Range`、`Content-Length` 准确），不带回 200；都带 `Accept-Ranges: bytes`、`ETag`、长缓存（`If-None-Match` 命中回 304）。`public/` 里不再放 mp3。
- **节目单在 KV**（命名空间绑定 `SCHEDULE`）：`seed:<版本号>` 是整份节目单，`pointer` 是 `{ "version": 线上版本, "previous": 上一版 }`。`/api/schedule` 读指针对应的 seed，返回里带 `version`。播放器每分钟查一次，版本变了自动接上，不用刷新。
- **配图在 R2**（同一个桶，key 前缀 `img/`）：节目单里不放第三方图片地址，`item.image` 只能是 `/img/<16 位 hex>.<jpg|png|webp>` 或 `null`（`publicItem` 会把别的都置空，`release.mjs check` 也会拦）。Worker 的 `/img/*` 只认这三种扩展名，`Content-Type` 由我们按扩展名定（不读 R2 元数据），从不出 SVG，带 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、长缓存和 ETag/304。
  - 转存用 `src/images.js`：
    ```js
    import { storeImage } from "./src/images.js";
    // store：R2 桶的样子 —— head(key) → 对象或 null；put(key, bytes, { httpMetadata: { contentType } })
    const image = await storeImage(store, imageUrl, pageUrl, { fetch });  // → "/img/<key>" 或 null
    ```
    只收 https；下载后按文件头认 jpg / png / webp（不看扩展名和源站 Content-Type，SVG、GIF 一律不收）；≤ 2MB；存到 `img/<sha256(pageUrl) 前 16 位>.<ext>`，已存在就跳过；任何失败返回 `null`，从不抛错。
  - Worker 里 `store` 传 `env.AUDIO`；box 上构建时传 `scripts/r2-images.mjs` 的 `r2ImageStore()`（head 走线上 `/img/` 的 HEAD，put 走 `wrangler r2 object put`）。`build-items.mjs` 最后会把每条的封面图（补料时从原文页读的 og:image / twitter:image）过一遍；单独补跑：`node scripts/r2-images.mjs items.json`。
  - GitHub 条目的原文是 README（不是网页），暂时没有封面图（`image: null`）。
- 本地 `releases/<版本号>/seed.json` 进 git；音频（`audio-cache/`、旧的 `releases/<版本号>/audio/`）只在本机（.gitignore），线上以 R2 为准。
- 新版本：`scripts/tts_seed.py items.json <版本号>` 生成到 `releases/<版本号>/` → `node scripts/release.mjs publish <版本号>`（校验后把 R2 里还没有的音频传上去、seed 写 KV，**不切换**）→ `node scripts/release.mjs use <版本号>`（再校验一遍，并逐条 HEAD 线上 `/audio/…` 确认 200 + audio/mpeg + 长度一致；**可播少于 15 条就不切**；通过后一步改 KV 指针）。不需要重新部署 Worker。
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
  "audio": "/audio/3f9c0a1b2d4e5f60.mp3",
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
