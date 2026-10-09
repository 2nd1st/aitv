"""本地最小版：把 build-items 的输出逐条合成豆包语音，写 public/audio 和 public/seed.json。
用法：node scripts/build-items.mjs 10 > /tmp/items.json && .venv/bin/python scripts/tts_seed.py /tmp/items.json
需要环境变量 DOUBAO_TTS_ACCESS_TOKEN（豆包语音 API Key）。"""
import asyncio, json, os, re, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from doubao_podcast import run

SPEAKERS = ["zh_male_dayixiansheng_v2_saturn_bigtts", "zh_female_mizaitongxue_v2_saturn_bigtts"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO = os.path.join(ROOT, "public", "audio")
ANCHOR_MS = 1760000000000  # 固定锚点：所有设备按同一个时钟算位置

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
        it2 = {k: v for k, v in it.items() if k != "lines"}
        it2.update(audio=f"/audio/{name}", duration=round(d + 0.6, 3), spoken="".join(it["lines"]),
                   rounds=[{"text": r["text"], "start_time": r["start_time"], "end_time": r["end_time"]} for r in rounds])
        out.append(it2)
        print(f"{i+1}/{len(items)}", it["id"], round(d, 1), "秒")
    json.dump({"anchorMs": ANCHOR_MS, "items": out}, open(os.path.join(ROOT, "public", "seed.json"), "w"),
              ensure_ascii=False, indent=1)
    print("seed.json 写好，", len(out), "条")

asyncio.run(main(sys.argv[1]))
