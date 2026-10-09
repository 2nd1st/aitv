import asyncio, json, os, struct, sys, uuid, gzip
import websockets

URL = "wss://openspeech.bytedance.com/api/v3/sami/podcasttts"
EV = {"StartConnection":1,"FinishConnection":2,"StartSession":100,"FinishSession":102}

def frame(event, payload: dict, session_id=None):
    body = json.dumps(payload, ensure_ascii=False).encode()
    hdr = bytes([0x11, 0x14, 0x10, 0x00])
    out = hdr + struct.pack(">I", event)
    if session_id is not None:
        sid = session_id.encode()
        out += struct.pack(">I", len(sid)) + sid
    out += struct.pack(">I", len(body)) + body
    return out

def parse(msg: bytes):
    mtype = msg[1] >> 4; flags = msg[1] & 0x0F
    ser = msg[2] >> 4; comp = msg[2] & 0x0F
    p = 4
    if mtype == 0b1111:
        code = struct.unpack(">I", msg[p:p+4])[0]; p += 4
        n = struct.unpack(">I", msg[p:p+4])[0]; p += 4
        data = msg[p:p+n]
        if comp == 1: data = gzip.decompress(data)
        return {"error": code, "payload": data.decode(errors="ignore")}
    event = None
    if flags & 0b0100:
        event = struct.unpack(">I", msg[p:p+4])[0]; p += 4
    sid = None
    if event not in (None,):
        n = struct.unpack(">I", msg[p:p+4])[0]; p += 4
        sid = msg[p:p+n].decode(errors="ignore"); p += n
    n = struct.unpack(">I", msg[p:p+4])[0]; p += 4
    data = msg[p:p+n]
    if comp == 1: data = gzip.decompress(data)
    return {"mtype": mtype, "event": event, "sid": sid, "ser": ser, "data": data}

async def run(payload, out_path, meta_path):
    headers = {
        "X-Api-Key": os.environ["DOUBAO_TTS_ACCESS_TOKEN"],
        "X-Api-Resource-Id": "volc.service_type.10050",
        "X-Api-Request-Id": str(uuid.uuid4()),
    }
    rounds = []; audio = bytearray(); cur = None
    async with websockets.connect(URL, additional_headers=headers, max_size=None, open_timeout=30) as ws:
        print("logid:", ws.response.headers.get("X-Tt-Logid"))
        await ws.send(frame(EV["StartConnection"], {}))
        r = parse(await ws.recv()); print("conn:", r.get("event"), r.get("error"), r.get("payload",""))
        if r.get("error"): return
        sid = str(uuid.uuid4())
        await ws.send(frame(EV["StartSession"], payload, sid))
        await ws.send(frame(EV["FinishSession"], {}, sid))
        while True:
            r = parse(await asyncio.wait_for(ws.recv(), timeout=300))
            if r.get("error"):
                print("ERROR", r); break
            ev = r["event"]
            if ev == 361:
                audio += r["data"]; continue
            txt = r["data"].decode(errors="ignore")
            if ev == 360:
                cur = json.loads(txt); print("round", cur.get("round_id"), cur.get("speaker","")[:20], (cur.get("text") or "")[:40])
            elif ev == 362:
                m = json.loads(txt)
                if cur: cur.update(m); rounds.append(cur); cur = None
                if m.get("is_error"): print("round error", m)
            elif ev in (150,154,363):
                print("event", ev, txt[:300])
            elif ev == 152:
                print("session finished", txt); break
            else:
                print("event", ev, txt[:300])
        await ws.send(frame(EV["FinishConnection"], {}))
    open(out_path, "wb").write(audio)
    json.dump(rounds, open(meta_path, "w"), ensure_ascii=False, indent=1)
    print("audio bytes", len(audio), "rounds", len(rounds))

if __name__ == "__main__":
    payload = json.load(open(sys.argv[1]))
    asyncio.run(run(payload, sys.argv[2], sys.argv[3]))
