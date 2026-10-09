package ai.qiaomu.aitv

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/**
 * 电视这一屏：screen/tv.js 默认画面的原生版。只由 (item, t, nowMs, upcoming) 决定，两台设备这几个值相同，画面相同。
 * 尺寸基准 u = 16:9 能放下的最大宽度的 1%（网页里的 1cqw）；小屏给字号下限，正文放不下就整体缩一点。
 */
@SuppressLint("ViewConstructor")
class TvView(context: Context, private val actions: Actions) : FrameLayout(context) {

    interface Actions {
        fun onScreenTap()
        fun onGoLive()
        fun onOpen(url: String)
    }

    private val dp = resources.displayMetrics.density
    private var u = 8f

    private val studio = StudioView(context)
    private val logo = text(INK, bold = true).apply { text = "AI 今天"; letterSpacing = 0.12f }
    private val logoDot = View(context)
    private val logoBox = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
    private val stateDot = View(context)
    private val state = text(INK_2).apply { letterSpacing = 0.14f }
    private val bug = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
    private val clockT = text(INK, bold = true)
    private val clockS = text(INK_DIM).apply { text = "北京时间"; letterSpacing = 0.16f }
    private val clockBox = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.END }
    private val card = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL }
    private val band = FrameLayout(context).apply { setBackgroundColor(BAND) }
    private val tag = text(Color.parseColor("#130d04"), bold = true).apply { text = "接下来"; gravity = Gravity.CENTER; setBackgroundColor(ACCENT); letterSpacing = 0.12f }
    private val ticker = TickerView(context)
    private val progTrack = View(context).apply { setBackgroundColor(0x14ffffff) }
    private val progBar = View(context).apply { setBackgroundColor(ACCENT); pivotX = 0f }
    private val goLive = text(Color.WHITE).apply { text = "● 回到直播"; gravity = Gravity.CENTER; letterSpacing = 0.12f; visibility = GONE }
    private val status = text(INK).apply { gravity = Gravity.CENTER; visibility = GONE }

    private class PartRow(val key: String, val row: LinearLayout, val label: TextView, val body: TextView, val start: Double)
    private var cardItem: Item? = null
    private var parts: List<PartRow> = emptyList()
    private var headline: TextView? = null
    private var scale = 1f
    private var paused = false
    private var lastClock = ""

    init {
        setBackgroundColor(ROOM)
        isClickable = true
        setOnClickListener { actions.onScreenTap() }
        addView(studio, LayoutParams(MATCH, MATCH))
        logoBox.addView(logoDot); logoBox.addView(logo)
        logoBox.background = pill(0x0fffffff, 0x14ffffff)
        bug.addView(logoBox); bug.addView(stateDot); bug.addView(state)
        addView(bug, LayoutParams(WRAP, WRAP))
        clockBox.addView(clockT); clockBox.addView(clockS)
        addView(clockBox, LayoutParams(WRAP, WRAP, Gravity.END))
        addView(card, LayoutParams(MATCH, MATCH))
        band.addView(tag, LayoutParams(WRAP, MATCH))
        band.addView(ticker, LayoutParams(MATCH, MATCH))
        band.addView(progTrack, LayoutParams(MATCH, 1))
        band.addView(progBar, LayoutParams(MATCH, 1))
        addView(band, LayoutParams(MATCH, WRAP, Gravity.BOTTOM))
        goLive.setOnClickListener { actions.onGoLive() }
        addView(goLive, LayoutParams(WRAP, WRAP, Gravity.BOTTOM or Gravity.END))
        addView(status, LayoutParams(WRAP, WRAP, Gravity.CENTER))
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        u = min(w.toFloat(), h * 16f / 9f) / 100f
        post { applySizes(); cardItem?.let { val i = it; cardItem = null; build(i) } }
    }

    // 字号：网页里的 em 值 × u，小屏不低于下限（dp）
    private fun size(em: Float, floorDp: Float) = max(em * u, floorDp * dp)

    private fun applySizes() {
        val pad = (3.4f * u).toInt()
        logo.setTextSize(TypedValue.COMPLEX_UNIT_PX, size(1.5f, 12f))
        val dot = (logo.textSize * 0.7f).toInt()
        logoDot.layoutParams = LinearLayout.LayoutParams(dot, dot).apply { rightMargin = (logo.textSize * 0.6f).toInt() }
        logoDot.background = GradientDrawable().apply { setColor(ACCENT); cornerRadius = dot * 0.22f }
        logoBox.setPadding((logo.textSize * 0.7f).toInt(), (logo.textSize * 0.45f).toInt(), (logo.textSize * 0.9f).toInt(), (logo.textSize * 0.45f).toInt())
        state.setTextSize(TypedValue.COMPLEX_UNIT_PX, size(1.25f, 10f))
        val sd = (state.textSize * 0.55f).toInt()
        stateDot.layoutParams = LinearLayout.LayoutParams(sd, sd).apply { leftMargin = (logo.textSize * 0.8f).toInt(); rightMargin = (state.textSize * 0.5f).toInt() }
        (bug.layoutParams as LayoutParams).apply { leftMargin = pad; topMargin = (3f * u).toInt() }
        clockT.setTextSize(TypedValue.COMPLEX_UNIT_PX, size(2.6f, 18f))
        clockS.setTextSize(TypedValue.COMPLEX_UNIT_PX, size(1.05f, 8f))
        (clockBox.layoutParams as LayoutParams).apply { rightMargin = pad; topMargin = (2.6f * u).toInt() }
        val bandH = max(5.6f * u, 28 * dp).toInt()
        band.layoutParams.height = bandH
        tag.setTextSize(TypedValue.COMPLEX_UNIT_PX, size(1.35f, 11f))
        tag.setPadding((2 * u).toInt().coerceAtLeast((12 * dp).toInt()), 0, (1.4f * u).toInt().coerceAtLeast((10 * dp).toInt()), 0)
        tag.measure(MeasureSpec.UNSPECIFIED, MeasureSpec.UNSPECIFIED)
        (ticker.layoutParams as LayoutParams).leftMargin = tag.measuredWidth
        ticker.setTextSize(size(1.4f, 11f))
        val ph = max(0.22f * u, 2 * dp).toInt()
        progTrack.layoutParams.height = ph; progBar.layoutParams.height = ph
        goLive.setTextSize(TypedValue.COMPLEX_UNIT_PX, size(1.35f, 11f))
        goLive.setPadding((goLive.textSize * 1.2f).toInt(), (goLive.textSize * 0.6f).toInt(), (goLive.textSize * 1.2f).toInt(), (goLive.textSize * 0.6f).toInt())
        goLive.background = GradientDrawable().apply { setColor(LIVE); cornerRadius = 999f }
        (goLive.layoutParams as LayoutParams).apply { rightMargin = pad; bottomMargin = bandH + (1.6f * u).toInt() }
        status.setTextSize(TypedValue.COMPLEX_UNIT_PX, max(15 * dp, 1.4f * u))
        status.setPadding((14 * dp).toInt(), (8 * dp).toInt(), (14 * dp).toInt(), (8 * dp).toInt())
        status.background = GradientDrawable().apply { setColor(0xf00a0a0b.toInt()); cornerRadius = 8 * dp }
        (card.layoutParams as LayoutParams).apply {
            leftMargin = pad; rightMargin = pad
            topMargin = (clockT.textSize * 1.9f + 3f * u).toInt().coerceAtLeast((10f * u).toInt())
            bottomMargin = bandH + (2f * u).toInt()
        }
        requestLayout()
    }

    // ---------- 每帧 ----------
    fun render(item: Item, t: Double, nowMs: Double, upcoming: List<Item>) {
        if (cardItem?.id != item.id) build(item)
        val c = beijingClock(nowMs)
        if (c != lastClock) { lastClock = c; clockT.text = c }

        // 入场：前 0.12 秒空着，0.45 秒淡入上浮
        val e = easeOut(((t - 0.12) / 0.45).toFloat())
        card.alpha = if (paused) e * 0.82f else e
        card.translationY = (1 - e) * 1.2f * u
        // 讲解分段：念到哪段亮哪段，后面的还没出现
        var live = 0
        parts.forEachIndexed { i, p -> if (t >= p.start) live = i }
        parts.forEachIndexed { i, p ->
            val a = if (t < p.start) 0f else easeOut(((t - p.start) / 0.4).toFloat())
            p.row.alpha = a
            p.row.translationY = (1 - a) * 0.6f * u
            val on = i == live
            p.label.setTextColor(if (on) ACCENT else INK_DIM)
            p.body.setTextColor(if (p.key == "take") (if (on) ACCENT else INK_2) else if (on) INK else INK_2)
        }
        progBar.scaleX = (t / max(item.duration, 0.001)).toFloat().coerceIn(0f, 1f)
        ticker.setItems(upcoming)
        ticker.offsetFor(nowMs, width)
    }

    fun setPaused(p: Boolean) {
        paused = p
        state.text = if (p) "已暂停" else "直播"
        state.setTextColor(if (p) ACCENT else INK_2)
        stateDot.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (p) ACCENT else LIVE) }
        goLive.visibility = if (p) VISIBLE else GONE
        studio.alpha = if (p) 0.8f else 1f
    }

    fun setStatus(message: String?) {
        status.text = message ?: ""
        status.visibility = if (message.isNullOrEmpty()) GONE else VISIBLE
    }

    // ---------- 每条的正文 ----------
    private fun build(item: Item) {
        cardItem = item
        card.removeAllViews()
        scale = 1f
        val kicker = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        val kSize = size(1.3f, 10f)
        kicker.addView(text(ACCENT, bold = true).apply { text = item.source; setTextSize(TypedValue.COMPLEX_UNIT_PX, kSize); letterSpacing = 0.12f })
        for ((key, show) in STATS.filter { item.number(it.first) != null }.take(2)) {
            kicker.addView(text(INK_DIM).apply {
                text = show(item.number(key)!!); setTextSize(TypedValue.COMPLEX_UNIT_PX, kSize)
            }, LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = kSize.toInt() })
        }
        item.url?.let { url ->
            kicker.addView(text(INK).apply {
                text = "看原文 ↗"; setTextSize(TypedValue.COMPLEX_UNIT_PX, kSize * 0.95f)
                setPadding((kSize * 0.95f).toInt(), (kSize * 0.35f).toInt(), (kSize * 0.95f).toInt(), (kSize * 0.35f).toInt())
                background = pill(0, 0x38ffffff)
                setOnClickListener { actions.onOpen(url) }
            }, LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = kSize.toInt() })
        }
        card.addView(kicker)

        val ps = Parts.of(item)
        val title = if (item.template == "caughtup") item.field("title") ?: "已追平" else item.title
        val h = text(INK, bold = true).apply {
            text = title
            setTextSize(TypedValue.COMPLEX_UNIT_PX, size(if (title.length > 34) 3.2f else 4f, 20f))
            setLineSpacing(0f, 1.1f)
            maxLines = 3; ellipsize = TextUtils.TruncateAt.END
            item.url?.let { url -> setOnClickListener { actions.onOpen(url) } }
        }
        headline = h
        card.addView(h, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = (kSize * 0.4f).toInt() })
        val orig = item.field("title")
        if (item.field("title_zh") != null && orig != null && orig != item.field("title_zh")) {
            card.addView(text(INK_DIM).apply {
                text = orig; setTextSize(TypedValue.COMPLEX_UNIT_PX, size(1.44f, 9f)); maxLines = 1; ellipsize = TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = (u * 0.5f).toInt() })
        }
        if (item.template == "caughtup") item.field("note")?.let {
            card.addView(text(INK_2).apply { text = it; setTextSize(TypedValue.COMPLEX_UNIT_PX, size(1.8f, 12f)) })
        }

        val bodySize = size(1.75f, 11f)
        val labelSize = size(1.19f, 9f)
        parts = ps.mapIndexed { i, p ->
            val row = LinearLayout(context)
            val label = text(INK_DIM).apply { text = p.label; setTextSize(TypedValue.COMPLEX_UNIT_PX, labelSize); letterSpacing = 0.18f }
            val body = text(INK_2, bold = p.key == "take").apply { text = p.text; setTextSize(TypedValue.COMPLEX_UNIT_PX, bodySize); setLineSpacing(0f, 1.3f) }
            row.addView(label, LinearLayout.LayoutParams((labelSize * 6.2f).toInt(), WRAP).apply { topMargin = (bodySize * 0.2f).toInt() })
            row.addView(body, LinearLayout.LayoutParams(0, WRAP, 1f))
            card.addView(row, LinearLayout.LayoutParams(min(width - 2 * (3.4f * u).toInt(), (38 * bodySize).toInt()), WRAP).apply {
                topMargin = if (i == 0) (2.2f * bodySize).toInt().coerceAtMost((3 * u).toInt().coerceAtLeast((10 * dp).toInt())) else (bodySize * 0.6f).toInt()
            })
            PartRow(p.key, row, label, body, p.start)
        }
        card.post { shrinkToFit() }
    }

    // 小屏上正文可能放不下：整体缩字，最多缩到 70%
    private fun shrinkToFit() {
        val avail = card.height
        if (avail <= 0) return
        repeat(6) {
            card.measure(MeasureSpec.makeMeasureSpec(card.width, MeasureSpec.EXACTLY), MeasureSpec.UNSPECIFIED)
            if (card.measuredHeight <= avail || scale <= 0.7f) return
            scale *= 0.92f
            scaleTexts(card, 0.92f)
        }
    }

    private fun scaleTexts(v: View, f: Float) {
        if (v is TextView) v.setTextSize(TypedValue.COMPLEX_UNIT_PX, v.textSize * f)
        if (v is ViewGroup) for (i in 0 until v.childCount) scaleTexts(v.getChildAt(i), f)
    }

    private fun text(color: Int, bold: Boolean = false) = TextView(context).apply {
        setTextColor(color)
        includeFontPadding = false
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun pill(fill: Int, stroke: Int) = GradientDrawable().apply {
        setColor(fill); cornerRadius = 999f
        if (stroke != 0) setStroke(max(1, dp.toInt()), stroke)
    }

    // ---------- 底部滚动条：位置由服务器时间算，各设备一致 ----------
    private class TickerView(context: Context) : View(context) {
        private val src = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ACCENT; typeface = Typeface.DEFAULT_BOLD }
        private val ttl = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = INK_2 }
        private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = INK_DIM }
        private var key = ""
        private var items: List<Item> = emptyList()
        private var trackW = 0f
        private var x = 0f

        fun setTextSize(px: Float) { src.textSize = px; ttl.textSize = px; dot.textSize = px; measureTrack() }

        fun setItems(list: List<Item>) {
            val k = list.joinToString("|") { it.id + it.audio }
            if (k == key) return
            key = k; items = list; measureTrack()
        }

        private fun gap() = ttl.textSize * 1.2f
        private fun measureTrack() {
            trackW = items.sumOf { (src.measureText(it.source) + gap() * 0.5f + ttl.measureText(it.title) + gap() * 2 + dot.measureText("·")).toDouble() }.toFloat()
        }

        fun offsetFor(nowMs: Double, screenW: Int) {
            if (trackW <= 0) return
            x = (((nowMs / 1000.0) * screenW * 0.06) % trackW).toFloat()
            invalidate()
        }

        override fun onDraw(canvas: Canvas) {
            if (items.isEmpty() || trackW <= 0) return
            val y = height / 2f - (ttl.descent() + ttl.ascent()) / 2f
            var cx = -x + gap()
            canvas.save()
            canvas.clipRect(0, 0, width, height)
            while (cx < width) {
                for (it in items) {
                    if (cx > width) break
                    canvas.drawText(it.source, cx, y, src); cx += src.measureText(it.source) + gap() * 0.5f
                    canvas.drawText(it.title, cx, y, ttl); cx += ttl.measureText(it.title) + gap()
                    canvas.drawText("·", cx, y, dot); cx += dot.measureText("·") + gap()
                }
            }
            canvas.restore()
        }
    }

    // ---------- 演播室底 ----------
    private class StudioView(context: Context) : View(context) {
        private val base = Paint()
        private val warm = Paint()
        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            base.shader = RadialGradient(w * 0.1f, 0f, max(w, h) * 1.1f, intArrayOf(0xff1d1c19.toInt(), 0xff0b0b0c.toInt()), floatArrayOf(0f, 0.68f), Shader.TileMode.CLAMP)
            warm.shader = RadialGradient(w * 0.82f, h * 0.3f, w * 0.6f, intArrayOf(0x12ffb547, 0x00ffb547), null, Shader.TileMode.CLAMP)
        }
        override fun onDraw(canvas: Canvas) {
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), base)
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), warm)
        }
    }

    companion object {
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        val ROOM = Color.parseColor("#0a0a0b")
        val INK = Color.parseColor("#f4f1ea")
        val INK_2 = Color.argb(184, 244, 241, 234)
        val INK_DIM = Color.argb(117, 244, 241, 234)
        val ACCENT = Color.parseColor("#ffb547")
        val LIVE = Color.parseColor("#ff3b30")
        val BAND = Color.argb(219, 12, 12, 13)

        private val fmt = NumberFormat.getIntegerInstance(Locale.CHINA)
        private fun f(v: Double) = fmt.format(v.toLong())
        // 角标：只显示源数据里真有的数字（和网页一致）
        val STATS: List<Pair<String, (Double) -> String>> = listOf(
            "rank" to { v -> "第 ${f(v)} 名" },
            "points" to { v -> "${f(v)} 分" },
            "comments" to { v -> "${f(v)} 评论" },
            "stars_today" to { v -> "今日 +${f(v)} 星" },
            "starsToday" to { v -> "今日 +${f(v)} 星" },
            "stars" to { v -> "${f(v)} 星" },
            "votes" to { v -> "${f(v)} 票" },
        )

        fun beijingClock(nowMs: Double): String {
            val m = ((nowMs / 60000).toLong() + 8 * 60) % (24 * 60)
            return String.format(Locale.ROOT, "%02d:%02d", m / 60, m % 60)
        }

        // cubic-bezier(0.23, 1, 0.32, 1) 的近似：快出慢收
        fun easeOut(x: Float): Float {
            val c = x.coerceIn(0f, 1f)
            return 1 - (1 - c) * (1 - c) * (1 - c) * (1 - c)
        }

    }
}
