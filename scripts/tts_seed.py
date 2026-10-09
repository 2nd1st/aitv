"""把 build-items 的输出逐条合成豆包语音，写成一个独立版本：
  releases/<version>/seed.json（带 version）。音频按内容寻址：key = sha256(音色 + 合成参数 + 口播稿)[:16]，
  地址 /audio/<hash>.mp3，文件在 audio-cache/<hash>.mp3（+ <hash>.json 存分句时间轴）。
  同一份稿子、同一套音色已经合成过（本地缓存或 R2 里有）就不再调 TTS——给以后的定时任务省钱省时间。
不碰线上版本；上线：scripts/release.mjs publish <version>（传 R2 + KV），再 use <version>（校验、可播 >= 15 条才切指针）。
用法：node scripts/build-items.mjs 20 > /tmp/items.json && /workspace/podcast/.venv/bin/python scripts/tts_seed.py /tmp/items.json [version]
version 不给就用东八区当前时间，如 20261009-1130。
进 seed 的字段走白名单（SEED_KEYS），原文（materialText 等）一律不写进去。
需要环境变量 DOUBAO_TTS_ACCESS_TOKEN（豆包语音 API Key）。"""
import asyncio, hashlib, json, os, re, shutil, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from doubao_podcast import run

SPEAKERS = ["zh_male_dayixiansheng_v2_saturn_bigtts", "zh_female_mizaitongxue_v2_saturn_bigtts"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import datetime
VERSION = sys.argv[2] if len(sys.argv) > 2 else datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d-%H%M")
assert re.fullmatch(r"\d{8}-\d{4,6}", VERSION), VERSION
OUT = os.path.join(ROOT, "releases", VERSION)
CACHE = os.path.join(ROOT, "audio-cache")
BUCKET = "aitv-audio"
AUDIO_CONFIG = {"format": "mp3", "sample_rate": 24000, "speech_rate": 10}
ANCHOR_MS = 1760000000000  # 固定锚点：所有设备按同一个时钟算位置

SEED_KEYS = ["id", "source", "url", "fetchedAt", "publishedAt", "dateUnknown", "pubDateSource", "rankedAt", "template", "focus", "kind", "image", "fields", "brief", "script", "take"]
PART_KEYS = ["what", "who", "take"]

def tag_parts(rounds, lines):
    """每句 round 标上属于哪段（what / who / take），画面据此逐段亮起。
    三段各合成一句时一一对应；豆包若把某段拆成多句，就按累计字数归段。"""
    if len(rounds) == len(lines):
        for r, k in zip(rounds, PART_KEYS): r["part"] = k
        return rounds
    bounds, acc = [], 0
    for l in lines: acc += len(l); bounds.append(acc)
    pos = 0
    for r in rounds:
        mid = pos + len(r["text"]) / 2
        i = next((j for j, b in enumerate(bounds) if mid <= b), len(bounds) - 1)
        r["part"] = PART_KEYS[min(i, 2)]
        pos += len(r["text"])
    return rounds

def audio_key(lines):
    """内容地址：音色、合成参数、每段稿子都算进去，任何一样变了就是新文件。"""
    spec = {"speakers": SPEAKERS, "audio_config": AUDIO_CONFIG, "use_head_music": False, "texts": list(lines)}
    return hashlib.sha256(json.dumps(spec, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]

def from_r2(key, mp3, meta):
    """本地没有就去 R2 看看（换机器 / 清了缓存时）。两个都拿到才算命中。"""
    try:
        for obj, dst in ((f"{key}.json", meta), (f"{key}.mp3", mp3)):
            subprocess.run(["npx", "wrangler", "r2", "object", "get", f"{BUCKET}/{obj}", "--file", dst, "--remote"],
                           check=True, capture_output=True, cwd=ROOT, timeout=120)
        return os.path.getsize(mp3) > 1000
    except Exception:
        for f in (mp3, meta):
            if os.path.exists(f): os.remove(f)
        return False

def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return float(out) if out else 0.0

async def main(src):
    items = json.load(open(src))
    os.makedirs(OUT, exist_ok=True); os.makedirs(CACHE, exist_ok=True)
    out, hits = [], 0
    for i, it in enumerate(items):
        key = audio_key(it["lines"])
        path, meta = os.path.join(CACHE, key + ".mp3"), os.path.join(CACHE, key + ".json")
        cached = os.path.exists(path) and os.path.exists(meta) and os.path.getsize(path) > 1000
        if not cached and from_r2(key, path, meta): cached = True
        if cached:
            hits += 1
            rounds = json.load(open(meta))
        else:
            payload = {"action": 3, "use_head_music": False, "audio_config": AUDIO_CONFIG,
                       "nlp_texts": [{"speaker": SPEAKERS[j % 2], "text": t} for j, t in enumerate(it["lines"])]}
            tmp_mp3, tmp_meta = tempfile.mktemp(suffix=".mp3"), tempfile.mktemp(suffix=".json")
            try:
                await run(payload, tmp_mp3, tmp_meta)
                rounds = json.load(open(tmp_meta))
            except Exception as e:  # 这一条失败就跳过，不影响整份节目单
                print("跳过", it["id"], e); continue
            if duration(tmp_mp3) <= 0: print("跳过（无音频）", it["id"]); continue
            shutil.move(tmp_mp3, path)
            json.dump(rounds, open(meta, "w"), ensure_ascii=False)
        d = duration(path)
        if d <= 0: print("跳过（无音频）", it["id"]); continue
        it2 = {k: it[k] for k in SEED_KEYS if k in it}
        it2.update(audio=f"/audio/{key}.mp3", duration=round(d + 0.6, 3), spoken="".join(it["lines"]),
                   rounds=tag_parts([{"text": r["text"], "start_time": r["start_time"], "end_time": r["end_time"]} for r in rounds], it["lines"]))
        out.append(it2)
        print(f"{i+1}/{len(items)}", it["id"], key, round(d, 1), "秒", "（缓存）" if cached else "（新合成）")
    json.dump({"version": VERSION, "anchorMs": ANCHOR_MS, "items": out}, open(os.path.join(OUT, "seed.json"), "w"),
              ensure_ascii=False, indent=1)
    print("版本", VERSION, "seed.json 写好，", len(out), "条（其中", hits, "条复用已有音频）→", OUT)

asyncio.run(main(sys.argv[1]))
