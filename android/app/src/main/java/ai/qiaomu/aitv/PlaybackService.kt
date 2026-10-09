package ai.qiaomu.aitv

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.Build
import android.os.IBinder

/**
 * 播放放在前台服务里：熄屏、切到别的 App 也接着播（收音机模式），通知栏和媒体键可以暂停 / 继续 / 关掉。
 * 界面（MainActivity）绑定这个服务，每帧从 player 读位置来画。
 */
class PlaybackService : Service(), LivePlayer.Listener {

    inner class LocalBinder : Binder() {
        val service: PlaybackService get() = this@PlaybackService
    }

    lateinit var player: LivePlayer
        private set
    var ui: LivePlayer.Listener? = null
    var onClose: (() -> Unit)? = null
    private lateinit var session: MediaSession
    private lateinit var audio: AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var item: Item? = null

    override fun onCreate() {
        super.onCreate()
        audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        player = LivePlayer(this, Api(BuildConfig.ORIGIN), this)

        session = MediaSession(this, "AITV")
        session.setCallback(object : MediaSession.Callback() {
            override fun onPlay() = userResume()
            override fun onPause() = userPause()
            override fun onStop() = close()
            override fun onSkipToNext() = player.goLive()
        })
        session.setSessionActivity(PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
        session.isActive = true

        @Suppress("DEPRECATION")
        wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager)
            ?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "aitv")
            ?.apply { setReferenceCounted(false); acquire() }

        if (Build.VERSION.SDK_INT >= 26) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW))
        }
        goForeground()
        requestFocus()
        player.start()
        updateSession()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TOGGLE -> userToggle()
            ACTION_STOP -> close()
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent): IBinder = LocalBinder()

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        player.stop()
        session.isActive = false
        session.release()
        abandonFocus()
        wifiLock?.release()
        ui = null
        super.onDestroy()
    }

    // 用户的操作（界面、按键）：先取消「抢回焦点」，免得刚按了暂停又自己播起来
    fun userToggle() { main.removeCallbacks(reclaim); player.toggle() }
    fun userPause() { main.removeCallbacks(reclaim); player.pause() }
    fun userResume() { main.removeCallbacks(reclaim); player.resume() }

    // 从最近任务里划掉 = 关掉
    override fun onTaskRemoved(rootIntent: Intent?) = close()

    // 通知栏「关闭」/ 媒体停止键：停播，界面开着也一起关
    private fun close() {
        player.stop()
        onClose?.invoke()
        stopSelf()
    }

    // ---------- LivePlayer.Listener：转给界面，同时更新通知和媒体会话 ----------
    override fun onStatus(message: String?) { ui?.onStatus(message) }

    override fun onItemChanged(item: Item?) {
        this.item = item
        ui?.onItemChanged(item)
        updateSession()
    }

    override fun onPausedChanged(paused: Boolean) {
        ui?.onPausedChanged(paused)
        if (paused) abandonFocus() else requestFocus()
        updateSession()
    }

    private fun updateSession() {
        val paused = player.paused
        session.setPlaybackState(PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                PlaybackState.ACTION_STOP or PlaybackState.ACTION_SKIP_TO_NEXT)
            .setState(if (paused) PlaybackState.STATE_PAUSED else PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
            .build())
        item?.let {
            session.setMetadata(MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, it.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, it.source)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, getString(R.string.app_name))
                .build())
        }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification())
    }

    @SuppressLint("InlinedApi")
    private fun goForeground() {
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(NOTIFICATION_ID, notification())
    }

    private fun notification(): Notification {
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        val paused = if (::player.isInitialized) player.paused else false
        // Icon 版的 Action.Builder 要 API 23；资源 id 版在 21 上就有
        @Suppress("DEPRECATION")
        fun action(icon: Int, title: String, action: String) = Notification.Action.Builder(
            icon, title,
            PendingIntent.getService(this, action.hashCode(), Intent(this, PlaybackService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE),
        ).build()
        return b.setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(item?.title ?: getString(R.string.app_name))
            .setContentText(item?.source ?: getString(R.string.tagline))
            .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
            .setOngoing(!paused)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(action(if (paused) R.drawable.ic_play else R.drawable.ic_pause, if (paused) "继续" else "暂停", ACTION_TOGGLE))
            .addAction(action(R.drawable.ic_close, "关闭", ACTION_STOP))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1))
            .build()
    }

    // ---------- 音频焦点：被别的媒体拿走就暂停；语音助手这类短暂占用只静音，时间线照走 ----------
    // 有的设备（小爱触屏音箱）熄屏时会「假抢」一下永久焦点再立刻放掉，用来停掉第三方播放。
    // 所以失去焦点后 30 秒内每秒看一眼：没有别的声音在放，就把焦点拿回来、追到直播接着播；真有别的 App 在放就不抢。
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private var reclaimTries = 0
    private val reclaim = object : Runnable {
        override fun run() {
            if (!player.paused) return
            if (!audio.isMusicActive) {
                requestFocus()
                player.goLive()
            } else if (++reclaimTries < 30) main.postDelayed(this, 1000)
        }
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                player.pause()
                reclaimTries = 0
                main.removeCallbacks(reclaim)
                main.postDelayed(reclaim, 1000)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> player.setDucked(true)
            AudioManager.AUDIOFOCUS_GAIN -> player.setDucked(false)
        }
    }

    private fun requestFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            val req = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener(focusListener).build().also { focusRequest = it }
            audio.requestAudioFocus(req)
        } else {
            @Suppress("DEPRECATION")
            audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        }
    }

    private fun abandonFocus() {
        if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { audio.abandonAudioFocusRequest(it) }
        else @Suppress("DEPRECATION") audio.abandonAudioFocus(focusListener)
    }

    companion object {
        const val CHANNEL = "playback"
        const val NOTIFICATION_ID = 1
        const val ACTION_TOGGLE = "ai.qiaomu.aitv.TOGGLE"
        const val ACTION_STOP = "ai.qiaomu.aitv.STOP"
    }
}
