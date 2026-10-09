// 口播稿内容 hash：跟音频文件名同一个依据（scripts/tts_seed.py 的 audio_key）：
//   sha256(json.dumps({speakers, audio_config, use_head_music, texts}, ensure_ascii=False, sort_keys=True))[:16]
// 这里按 Python json.dumps 的默认格式（", " / ": "、键排序、不转义非 ASCII）序列化，两边算出来一样。
export const SPEAKERS = ["zh_male_dayixiansheng_v2_saturn_bigtts", "zh_female_mizaitongxue_v2_saturn_bigtts"];
export const AUDIO_CONFIG = { format: "mp3", sample_rate: 24000, speech_rate: 10 };

export function pyJSON(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "string") return JSON.stringify(v); // JSON.stringify 不转义非 ASCII，跟 ensure_ascii=False 一致
  if (Array.isArray(v)) return `[${v.map(pyJSON).join(", ")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}: ${pyJSON(v[k])}`).join(", ")}}`;
}

export async function scriptHash(lines, { speakers = SPEAKERS, audioConfig = AUDIO_CONFIG } = {}) {
  const spec = { speakers, audio_config: audioConfig, use_head_music: false, texts: [...lines] };
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pyJSON(spec)));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
