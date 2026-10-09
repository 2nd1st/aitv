package ai.qiaomu.aitv

import android.os.SystemClock
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// 和网页端 public/client.js 一样的两个请求：校时、拉节目单。全部在后台线程调用。
class Api(private val origin: String) {

    // 校时结果：服务器时间 = elapsedRealtime + offset。用开机以来的单调时钟，不受用户改系统时间影响。
    data class Clock(val offset: Double, val rtt: Double) {
        fun now(): Double = SystemClock.elapsedRealtimeNanos() / 1e6 + offset
    }

    private val pool = Executors.newFixedThreadPool(4)

    fun audioUrl(path: String) = origin + path

    private fun get(path: String, timeoutMs: Int): String {
        val c = URL(origin + path).openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        c.useCaches = false
        c.setRequestProperty("Cache-Control", "no-store")
        c.setRequestProperty("User-Agent", "AITV-Android/${BuildConfig.VERSION_NAME}")
        try {
            if (c.responseCode !in 200..299) throw java.io.IOException("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    // 测 7 次往返，取往返最短的那次：偏差 = 服务器时间 - 本地中点
    fun measureClock(samples: Int = 7): Clock {
        val jobs = (1..samples).map {
            pool.submit(Callable {
                val t0 = SystemClock.elapsedRealtimeNanos() / 1e6
                val now = JSONObject(get("/api/time", 5000)).getDouble("now")
                val t1 = SystemClock.elapsedRealtimeNanos() / 1e6
                if (!now.isFinite()) throw java.io.IOException("Invalid server time")
                Clock(offset = now - (t0 + t1) / 2, rtt = t1 - t0)
            })
        }
        val ok = jobs.mapNotNull { runCatching { it.get(8, TimeUnit.SECONDS) }.getOrNull() }
        return ok.minByOrNull { it.rtt } ?: throw java.io.IOException("Clock unavailable")
    }

    fun schedule(): State =
        Timeline.adopt(JSONObject(get("/api/schedule?compact=1", 15000))) ?: throw java.io.IOException("Invalid schedule")
}
