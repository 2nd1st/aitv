"""本地最小版：把 build-items 的输出逐条合成豆包语音，写 public/audio 和 public/seed.json。
用法：node scripts/build-items.mjs 20 > /tmp/items.json && /workspace/podcast/.venv/bin/python scripts/tts_seed.py /tmp/items.json
写完 seed.json 后，public/audio 里不再被引用的旧 mp3 会删掉。
进 seed 的字段走白名单（SEED_KEYS），原文（materialText 等）一律不写进去。
需要环境变量 DOUBAO_TTS_ACCESS_TOKEN（豆包语音 API Key）。"""
import asyncio, json, os, re, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from doubao_podcast import run

SPEAKERS = ["zh_male_dayixiansheng_v2_saturn_bigtts", "zh_female_mizaitongxue_v2_saturn_bigtts"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO = os.path.join(ROOT, "public", "audio")
ANCHOR_MS = 1760000000000  # 固定锚点：所有设备按同一个时钟算位置

SEED_KEYS = ["id", "source", "url", "fetchedAt", "publishedAt", "template", "focus", "fields", "brief", "script", "take"]
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
        it2.update(audio=f"/audio/{name}", duration=round(d + 0.6, 3), spoken="".join(it["lines"]),
                   rounds=tag_parts([{"text": r["text"], "start_time": r["start_time"], "end_time": r["end_time"]} for r in rounds], it["lines"]))
        out.append(it2)
        print(f"{i+1}/{len(items)}", it["id"], round(d, 1), "秒")
    json.dump({"anchorMs": ANCHOR_MS, "items": out}, open(os.path.join(ROOT, "public", "seed.json"), "w"),
              ensure_ascii=False, indent=1)
    print("seed.json 写好，", len(out), "条")
    keep = {os.path.basename(x["audio"]) for x in out}
    for f in os.listdir(AUDIO):
        if f.endswith(".mp3") and f not in keep:
            os.remove(os.path.join(AUDIO, f)); print("删掉旧音频", f)

asyncio.run(main(sys.argv[1]))
