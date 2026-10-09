package ai.qiaomu.aitv

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.min

/**
 * 直播播放：和网页端 public/app.js 同一套规则。
 * - 直播位置 = 校准后的服务器时间；所有设备按同一个时钟播同一条的同一秒
 * - 每分钟重新校时 + 拉节目单；到 switchAt（条目边界）才换成 next
 * - 暂停后继续：落后直播 lag 毫秒接着播；「回到直播」清零
 * - 快到条目末尾就预加载下一条；漂移超过 0.4 秒拉回来
 * 所有方法都在主线程调用；网络在后台线程。
 */
class LivePlayer(private val context: Context, private val api: Api, private val listener: Listener) {

    interface Listener {
        fun onStatus(message: String?)
        fun onItemChanged(item: Item?)
        fun onPausedChanged(paused: Boolean)
    }

    private class Track(val item: Item, val mp: MediaPlayer) {
        var prepared = false
        var failed = false
        var failedAt = 0L
    }

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var clock: Api.Clock? = null
    @Volatile var state: State? = null
        private set
    private var running = false

    var paused = false
        private set
    private var frozenAt = 0.0
    private var lag = 0.0
    private var volume = 1f

    private var current: Track? = null
    private var upcoming: Track? = null
    private var lastFix = 0L
    private var lastLog = 0L
    private var lastItemId: String? = null
    var status: String? = "正在连接直播…"
        private set

    val ready: Boolean get() = clock != null && state != null
    fun now(): Double = clock?.now() ?: System.currentTimeMillis().toDouble()
    fun vnow(): Double = if (paused) frozenAt else now() - lag

    /** 本地时间线上此刻在播的条目和第几秒 */
    fun here(ms: Double = vnow()): Pair<Item?, Double> {
        val s = Timeline.pick(state, ms) ?: return null to 0.0
        if (s.items.isEmpty()) return null to 0.0
        val p = Timeline.locate(s, ms)
        return s.items[p.i] to p.t
    }

    fun upcoming(k: Int): List<Item> = Timeline.walk(state, vnow(), k + 1).drop(1)

    fun start() {
        if (running) return
        running = true
        setStatus("正在连接直播…")
        thread(name = "aitv-connect") {
            var c: Api.Clock? = null
            while (running && c == null) {
                c = runCatching { api.measureClock() }.getOrNull()
                if (c == null) { main.post { setStatus("暂时无法连接直播，正在重试…") }; SystemClock.sleep(3000) }
            }
            var s: State? = null
            var k = 0
            while (running && s == null) {
                s = runCatching { api.schedule() }.getOrNull()
                if (s == null) { main.post { setStatus("节目单暂时不可用，正在重试…") }; SystemClock.sleep(minOf(30000L, 2000L shl minOf(k++, 4))) }
            }
            main.post {
                if (!running) return@post
                clock = c; state = s
                setStatus(null)
                tick()
                main.postDelayed(refresher, 60_000)
            }
        }
    }

    fun stop() {
        running = false
        main.removeCallbacksAndMessages(null)
        current?.mp?.release(); current = null
        upcoming?.mp?.release(); upcoming = null
    }

    fun pause() {
        if (paused || !ready) return
        frozenAt = now() - lag
        paused = true
        current?.takeIf { it.prepared }?.mp?.pause()
        listener.onPausedChanged(true)
        setStatus(null)
    }

    fun resume() {
        if (!paused) return
        lag = now() - frozenAt
        paused = false
        listener.onPausedChanged(false)
        tick()
    }

    fun goLive() {
        val was = paused
        paused = false; lag = 0.0
        if (was) listener.onPausedChanged(false)
        current?.let { if (it.prepared) seekTo(it, here().second) }
        tick()
    }

    fun toggle() = if (paused) resume() else pause()

    /** 音频焦点被短暂拿走（语音助手、通知音）：静音但时间线照走，回来就在直播位置 */
    fun setDucked(ducked: Boolean) {
        volume = if (ducked) 0f else 1f
        current?.mp?.setVolume(volume, volume)
    }

    // 每分钟重新校时 + 拉节目单。服务器保证 switchAt 至少在 90 秒后，所以切换前一定能拿到 next。
    private val refresher = object : Runnable {
        override fun run() {
            if (!running) return
            thread(name = "aitv-refresh") {
                val c = runCatching { api.measureClock() }.getOrNull()
                val s = runCatching { api.schedule() }.getOrNull()
                main.post {
                    if (c != null && c.rtt < 1500) clock = c
                    if (s != null) state = s
                }
            }
            main.postDelayed(this, 60_000)
        }
    }

    private val ticker = Runnable { tick() }

    private fun tick() {
        main.removeCallbacks(ticker)
        if (!running || !ready) return
        val (item, t) = here()
        if (item?.id != lastItemId) { lastItemId = item?.id; listener.onItemChanged(item) }
        if (item == null) {
            current?.mp?.release(); current = null
            setStatus("暂无可播节目，更新后将自动接上直播")
        } else if (!paused) {
            sync(item, t)
            prefetch(item, t)
        }
        val remaining = if (item != null) ((item.duration - t) * 1000).toLong() else 250L
        main.postDelayed(ticker, remaining.coerceIn(20L, 250L))
    }

    private fun sync(item: Item, t: Double) {
        var tr = current
        // 加载失败：隔 2 秒重开一次，不要每个 tick 都重开
        if (tr != null && tr.failed && tr.item.audio == item.audio && SystemClock.elapsedRealtime() - tr.failedAt < 2000) return
        if (tr == null || tr.item.audio != item.audio || tr.failed) {
            tr?.mp?.release()
            tr = upcoming?.takeIf { it.item.audio == item.audio && !it.failed }?.also { upcoming = null } ?: open(item)
            current = tr
            tr.mp.setVolume(volume, volume)
            if (!tr.prepared) setStatus("声音正在缓冲…")
        }
        if (!tr.prepared) return
        val mp = tr.mp
        // 这条已经念完（音频文件可能比节目单时长短一点），等条目边界，不要重放末尾
        val audioEnd = if (mp.duration > 0) mp.duration / 1000.0 else item.duration
        if (t >= min(item.duration, audioEnd) - 0.05) return
        if (!mp.isPlaying) {
            if (BuildConfig.DEBUG) android.util.Log.i("AITV", "start ${item.id} t=%.2f pos=%.2f".format(t, mp.currentPosition / 1000.0))
            if (abs(mp.currentPosition / 1000.0 - t) > 0.25) seekTo(tr, t)
            mp.start()
            setStatus(null)
            return
        }
        // 漂移超过 0.4 秒拉回来，最多每 2 秒一次，避免来回拉扯
        val ms = SystemClock.elapsedRealtime()
        if (BuildConfig.DEBUG && ms - lastLog > 5000) {
            lastLog = ms
            android.util.Log.i("AITV", "sync ${item.id} target=%.2f pos=%.2f drift=%+.2f".format(t, mp.currentPosition / 1000.0, mp.currentPosition / 1000.0 - t))
        }
        if (abs(mp.currentPosition / 1000.0 - t) > 0.4 && ms - lastFix > 2000) {
            seekTo(tr, t); lastFix = ms
        }
    }

    // 离条目末尾不到 20 秒就把下一条准备好，换条时不等网络
    private fun prefetch(item: Item, t: Double) {
        if (item.duration - t > 20) return
        val nx = Timeline.walk(state, vnow(), 2).getOrNull(1) ?: return
        if (nx.audio == item.audio || upcoming?.item?.audio == nx.audio) return
        upcoming?.mp?.release()
        upcoming = open(nx)
    }

    private fun open(item: Item): Track {
        val mp = MediaPlayer()
        val tr = Track(item, mp)
        mp.setAudioAttributes(AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build())
        mp.setWakeMode(context, PowerManager.PARTIAL_WAKE_LOCK)
        mp.setOnPreparedListener {
            tr.prepared = true
            if (tr === current) tick()
        }
        mp.setOnInfoListener { _, what, _ ->
            if (tr === current && !paused) when (what) {
                MediaPlayer.MEDIA_INFO_BUFFERING_START -> setStatus("声音正在缓冲…")
                MediaPlayer.MEDIA_INFO_BUFFERING_END -> setStatus(null)
            }
            false
        }
        mp.setOnErrorListener { _, _, _ ->
            tr.failed = true; tr.failedAt = SystemClock.elapsedRealtime()
            if (tr === current) setStatus("声音加载失败，正在重试…")
            true
        }
        mp.setOnCompletionListener { if (tr === current) tick() }
        try {
            mp.setDataSource(api.audioUrl(item.audio))
            mp.prepareAsync()
        } catch (e: Exception) {
            tr.failed = true; tr.failedAt = SystemClock.elapsedRealtime()
        }
        return tr
    }

    private fun seekTo(tr: Track, t: Double) {
        val end = if (tr.mp.duration > 0) min(tr.item.duration, tr.mp.duration / 1000.0) else tr.item.duration
        val ms = (t.coerceIn(0.0, end - 0.05) * 1000).toLong()
        if (Build.VERSION.SDK_INT >= 26) tr.mp.seekTo(ms, MediaPlayer.SEEK_CLOSEST) else tr.mp.seekTo(ms.toInt())
    }

    private fun setStatus(message: String?) {
        if (status == message) return
        status = message
        listener.onStatus(message)
    }
}
