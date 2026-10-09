// DeepSeek（OpenAI 兼容）调用。key 只从调用方传入（env），不落盘、不打印。
export function makeDeepSeek({ apiKey, model = "deepseek-chat", baseUrl = "https://api.deepseek.com", timeoutMs = 120000, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("缺 DEEPSEEK_API_KEY");
  return async function llm(prompt, { json = true, temperature = 0.7 } = {}) {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature,
        // 原文截断可能留下半个 emoji（孤立代理项），API 会 400
        messages: [{ role: "user", content: String(prompt).toWellFormed?.() ?? String(prompt) }],
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  };
}
