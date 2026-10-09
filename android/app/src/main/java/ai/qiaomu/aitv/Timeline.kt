package ai.qiaomu.aitv

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.floor

// 节目单与时间线：public/timeline.js 的 Kotlin 版，语义保持一致（测试用例也对照着写）。
// 节目单 = { anchor, total, items: [{ start, duration, ... }] }，从 anchor 起连续排、循环播，时间都是服务器毫秒。
// 接口给 { current, next, switchAt }：所有设备按校准后的同一个时钟，到 switchAt（条目边界）才换成 next。

data class Round(val text: String, val start: Double, val part: String?)

data class Item(
    val id: String,
    val source: String,
    val url: String?,
    val template: String?,
    val audio: String,
    val start: Long,
    val duration: Double,
    val fields: JSONObject,
    val take: String?,
    val rounds: List<Round>,
) {
    fun field(key: String): String? = fields.optString(key, "").ifEmpty { null }
    fun number(key: String): Double? =
        if (fields.has(key) && fields.opt(key) is Number) fields.getDouble(key).takeIf { it.isFinite() } else null
    val title: String get() = field("title_zh") ?: field("title") ?: ""
}

data class Schedule(val version: String?, val anchor: Long, val total: Long, val items: List<Item>)

data class State(val current: Schedule, val next: Schedule?, val switchAt: Long?)

data class Position(val i: Int, val t: Double)

object Timeline {
    fun locate(s: Schedule?, nowMs: Double): Position {
        if (s == null || s.items.isEmpty() || s.total <= 0) return Position(0, 0.0)
        val total = s.total.toDouble()
        val pos = (((nowMs - s.anchor) % total) + total) % total
        for (i in s.items.indices) {
            // 一条的结束 = 下一条的开始（start 是整毫秒；用 duration 累加会在边界留下缝）
            val st = (s.items[i].start - s.anchor).toDouble()
            val en = if (i + 1 < s.items.size) (s.items[i + 1].start - s.anchor).toDouble() else total
            if (pos >= st && pos < en) return Position(i, (pos - st) / 1000.0)
        }
        return Position(0, 0.0)
    }

    fun pick(state: State?, nowMs: Double): Schedule? {
        if (state == null) return null
        if (state.next != null && state.switchAt != null && nowMs >= state.switchAt) return state.next
        return state.current
    }

    fun nextBoundary(s: Schedule?, atMs: Double): Double {
        if (s == null || s.items.isEmpty() || s.total <= 0) return atMs
        val loop = floor((atMs - s.anchor) / s.total).toLong()
        for (k in loop..loop + 1) {
            for (it in s.items) {
                val b = s.anchor + k * s.total + (it.start - s.anchor).toDouble()
                if (b >= atMs) return b
            }
        }
        return (s.anchor + (loop + 2) * s.total).toDouble()
    }

    // 从时刻 ms 起往后数 k 条（跨 switchAt 时换成 next 的条目）。逐个跳到下一个条目边界，不累加时长。
    fun walk(state: State?, ms: Double, k: Int): List<Item> {
        val out = ArrayList<Item>()
        var cur = ms
        repeat(k) {
            val s = pick(state, cur) ?: return out
            if (s.items.isEmpty()) return out
            out.add(s.items[locate(s, cur).i])
            var nb = nextBoundary(s, floor(cur) + 1)
            val sw = state?.switchAt
            if (state?.next != null && sw != null && cur < sw && sw < nb) nb = sw.toDouble()
            cur = nb
        }
        return out
    }

    // 接口 JSON → 状态；不合法返回 null（对应 public/client.js 的 validSchedule）
    fun adopt(body: JSONObject): State? {
        val current = parseSchedule(body.optJSONObject("current") ?: body) ?: return null
        val nextJson = body.optJSONObject("next")
        val next = if (nextJson != null) parseSchedule(nextJson) ?: return null else null
        val switchAt = if (next != null) body.optLong("switchAt", Long.MIN_VALUE).takeIf { it != Long.MIN_VALUE } ?: return null else null
        return State(current, next, switchAt)
    }

    fun parseSchedule(o: JSONObject): Schedule? {
        val arr = o.optJSONArray("items") ?: return null
        if (!o.has("anchor") || !o.has("total")) return null
        val total = o.getDouble("total")
        val items = ArrayList<Item>(arr.length())
        for (i in 0 until arr.length()) items.add(parseItem(arr.optJSONObject(i) ?: return null) ?: return null)
        if (items.isEmpty() && total != 0.0) return null
        if (items.isNotEmpty() && total <= 0) return null
        return Schedule(o.optString("version", "").ifEmpty { null }, o.getDouble("anchor").toLong(), total.toLong(), items)
    }

    private fun parseItem(o: JSONObject): Item? {
        val audio = o.optString("audio", "")
        if (!audio.startsWith("/audio/") || !o.has("start")) return null
        val duration = o.optDouble("duration", 0.0)
        if (!(duration > 0)) return null
        val rounds = ArrayList<Round>()
        val ra: JSONArray? = o.optJSONArray("rounds")
        if (ra != null) for (i in 0 until ra.length()) {
            val r = ra.optJSONObject(i) ?: continue
            rounds.add(Round(r.optString("text", ""), r.optDouble("start_time", 0.0), r.optString("part", "").ifEmpty { null }))
        }
        val fields = o.optJSONObject("fields") ?: JSONObject()
        return Item(
            id = o.optString("id", audio),
            source = o.optString("source", ""),
            url = o.optString("url", "").ifEmpty { null },
            template = o.optString("template", "").ifEmpty { null },
            audio = audio,
            start = o.getDouble("start").toLong(),
            duration = duration,
            fields = fields,
            take = (if (o.isNull("take")) null else o.optString("take", "")).takeUnless { it.isNullOrEmpty() }
                ?: fields.optString("take", "").ifEmpty { null },
            rounds = rounds,
        )
    }
}

// 讲解分段：是什么 / 跟你有关 / AI 点评（没有点评用亮点）。和 screen/tv.js 的 partsOf / partStarts 一致：
// 画面上的字和念的一致，rounds 标了 part 就用念的原句；每段从哪一秒亮起，优先用 rounds 的 start_time，否则按时长均分。
data class Part(val key: String, val label: String, val text: String, val start: Double)

object Parts {
    fun of(item: Item): List<Part> {
        fun spoken(key: String): String? =
            item.rounds.filter { it.part == key }.takeIf { it.isNotEmpty() }?.joinToString("") { it.text }
        val raw = ArrayList<Triple<String, String, String>>()
        item.field("what")?.let { raw.add(Triple("what", "是什么", spoken("what") ?: it)) }
        item.field("who")?.let { raw.add(Triple("who", "跟你有关", spoken("who") ?: it)) }
        if (item.take != null) raw.add(Triple("take", "AI 点评", spoken("take") ?: item.take))
        else item.field("highlight")?.let { raw.add(Triple("highlight", "亮点", it)) }
        return raw.mapIndexed { i, (key, label, text) ->
            val r = item.rounds.firstOrNull { it.part == key }
            Part(key, label, text, r?.start ?: (item.duration * i / raw.size))
        }
    }
}
