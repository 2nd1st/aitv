package ai.qiaomu.aitv

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class TimelineTest {
    // 对照数据由 android/scripts/timeline-fixture.mjs 用网页端的 public/timeline.js 生成
    @Test
    fun matchesWebTimeline() {
        val text = javaClass.classLoader!!.getResource("timeline-fixture.json").readText()
        val cases = JSONObject(text).getJSONArray("cases")
        var checked = 0
        for (c in 0 until cases.length()) {
            val case = cases.getJSONObject(c)
            val state = Timeline.adopt(case.getJSONObject("state"))
            assertNotNull(case.getString("name"), state)
            val queries = case.getJSONArray("queries")
            for (q in 0 until queries.length()) {
                val o = queries.getJSONObject(q)
                val t = o.getDouble("t")
                val s = Timeline.pick(state, t)!!
                val p = Timeline.locate(s, t)
                val where = "${case.getString("name")} t=$t"
                assertEquals(where, o.getString("version"), s.version)
                assertEquals(where, o.getInt("i"), p.i)
                assertEquals(where, o.getDouble("pos"), p.t, 1e-9)
                val walk = o.getJSONArray("walk")
                assertEquals(where, (0 until walk.length()).map { walk.getString(it) }, Timeline.walk(state, t, 6).map { it.id })
                checked++
            }
        }
        assert(checked > 300) { "only $checked queries" }
    }

    @Test
    fun rejectsInvalidSchedules() {
        assertNull(Timeline.adopt(JSONObject("""{"anchor":1,"total":10,"items":[{"audio":"x.mp3","start":1,"duration":5}]}""")))
        assertNull(Timeline.adopt(JSONObject("""{"anchor":1,"total":10,"items":[{"audio":"/audio/a.mp3","start":1,"duration":0}]}""")))
        assertNull(Timeline.adopt(JSONObject("""{"anchor":1,"total":10,"items":[]}""")))
        assertNotNull(Timeline.adopt(JSONObject("""{"anchor":1,"total":0,"items":[]}""")))
        // 有 next 就必须有 switchAt
        val one = """{"anchor":1,"total":5000,"items":[{"audio":"/audio/a.mp3","start":1,"duration":5}]}"""
        assertNull(Timeline.adopt(JSONObject("""{"current":$one,"next":$one}""")))
        assertNotNull(Timeline.adopt(JSONObject("""{"current":$one,"next":$one,"switchAt":5001}""")))
    }

    @Test
    fun partsFollowSpokenRounds() {
        val item = Timeline.parseSchedule(JSONObject("""{"anchor":0,"total":30000,"items":[{
            "id":"a","audio":"/audio/a.mp3","start":0,"duration":30,"source":"HN",
            "fields":{"what":"简版是什么","who":"简版跟你有关","highlight":"亮点"},
            "take":"点评",
            "rounds":[{"text":"念的是什么。","start_time":0,"part":"what"},
                      {"text":"念的跟你有关，","start_time":9.5,"part":"who"},
                      {"text":"第二句。","start_time":14,"part":"who"},
                      {"text":"念的点评。","start_time":25.2,"part":"take"}]}]}"""))!!.items[0]
        val parts = Parts.of(item)
        assertEquals(listOf("what", "who", "take"), parts.map { it.key })
        assertEquals("念的跟你有关，第二句。", parts[1].text)
        assertEquals(listOf(0.0, 9.5, 25.2), parts.map { it.start })
    }

    @Test
    fun partsFallBackToFieldsAndEvenSplit() {
        val item = Timeline.parseSchedule(JSONObject("""{"anchor":0,"total":30000,"items":[{
            "id":"a","audio":"/audio/a.mp3","start":0,"duration":30,
            "fields":{"what":"是什么","highlight":"亮点"}}]}"""))!!.items[0]
        val parts = Parts.of(item)
        assertEquals(listOf("是什么" to 0.0, "亮点" to 15.0), parts.map { it.text to it.start })
        assertEquals("亮点", parts[1].label)
    }
}
