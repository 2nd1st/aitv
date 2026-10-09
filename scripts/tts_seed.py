"""把 build-items 的输出逐条合成豆包语音，写成一个独立版本：
  public/seeds/<version>/audio/*.mp3 + public/seeds/<version>/seed.json（带 version）。
不碰线上版本；切换用 scripts/release.mjs use <version>（校验通过、可播 >= 15 条才切）。
用法：node scripts/build-items.mjs 20 > /tmp/items.json && /workspace/podcast/.venv/bin/python scripts/tts_seed.py /tmp/items.json [version]
version 不给就用东八区当前时间，如 20261009-1130。
进 seed 的字段走白名单（SEED_KEYS），原文（materialText 等）一律不写进去。
需要环境变量 DOUBAO_TTS_ACCESS_TOKEN（豆包语音 API Key）。"""
import asyncio, json, os, re, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from doubao_podcast import run

SPEAKERS = ["zh_male_dayixiansheng_v2_saturn_bigtts", "zh_female_mizaitongxue_v2_saturn_bigtts"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import datetime
VERSION = sys.argv[2] if len(sys.argv) > 2 else datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d-%H%M")
assert re.fullmatch(r"\d{8}-\d{4,6}", VERSION), VERSION
OUT = os.path.join(ROOT, "public", "seeds", VERSION)
AUDIO = os.path.join(OUT, "audio")
ANCHOR_MS = 1760000000000  # 固定锚点：所有设备按同一个时钟算位置

SEED_KEYS = ["id", "source", "url", "fetchedAt", "publishedAt", "template", "focus", "kind", "fields", "brief", "script", "take"]
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

def safe(s): return re.sub(r"[^A-Za-z0-9_-]+", "-", s)[:80]

def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return float(out) if out else 0.0

async def main(src):
    items = json.load(open(src))
    os.makedirs(AUDIO, exist_ok=True)
    out = []
    for i, it in enumerate(items):
        name = safe(it["id"]) + ".mp3"
        path = os.path.join(AUDIO, name)
        payload = {"action": 3, "use_head_music": False,
                   "audio_config": {"format": "mp3", "sample_rate": 24000, "speech_rate": 10},
                   "nlp_texts": [{"speaker": SPEAKERS[j % 2], "text": t} for j, t in enumerate(it["lines"])]}
        meta = tempfile.mktemp(suffix=".json")
        pf = tempfile.mktemp(suffix=".json"); json.dump(payload, open(pf, "w"), ensure_ascii=False)
        try:
            await run(payload, path, meta)
            rounds = json.load(open(meta))
        except Exception as e:  # 这一条失败就跳过，不影响整份节目单
            print("跳过", it["id"], e); continue
        d = duration(path)
        if d <= 0: print("跳过（无音频）", it["id"]); continue
        it2 = {k: it[k] for k in SEED_KEYS if k in it}
        it2.update(audio=f"/seeds/{VERSION}/audio/{name}", duration=round(d + 0.6, 3), spoken="".join(it["lines"]),
                   rounds=tag_parts([{"text": r["text"], "start_time": r["start_time"], "end_time": r["end_time"]} for r in rounds], it["lines"]))
        out.append(it2)
        print(f"{i+1}/{len(items)}", it["id"], round(d, 1), "秒")
    json.dump({"version": VERSION, "anchorMs": ANCHOR_MS, "items": out}, open(os.path.join(OUT, "seed.json"), "w"),
              ensure_ascii=False, indent=1)
    print("版本", VERSION, "seed.json 写好，", len(out), "条 →", OUT)
    keep = {os.path.basename(x["audio"]) for x in out}
    for f in os.listdir(AUDIO):  # 只清本版本目录里没用上的（比如合成失败的半成品）
        if f.endswith(".mp3") and f not in keep:
            os.remove(os.path.join(AUDIO, f)); print("删掉没用上的音频", f)

asyncio.run(main(sys.argv[1]))
