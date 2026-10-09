package ai.qiaomu.aitv

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.Choreographer
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager

/**
 * 打开就播：启动前台播放服务，画面每帧从服务里的 LivePlayer 读位置来画。
 * - 点画面 / 遥控确定键 / 播放暂停键：暂停或继续；方向键右：回到直播
 * - 返回键：关掉（停播）；Home 或熄屏：接着播，通知栏可控制
 */
class MainActivity : Activity(), LivePlayer.Listener, TvView.Actions {

    private lateinit var tv: TvView
    private var service: PlaybackService? = null
    private var framing = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val s = (binder as PlaybackService.LocalBinder).service
            service = s
            s.ui = this@MainActivity
            s.onClose = { finish() }
            tv.setPaused(s.player.paused)
            tv.setStatus(s.player.status)
            startFrames()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            service = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        tv = TvView(this, this)
        setContentView(tv)
        tv.setPaused(false)
        hideSystemUi()

        val intent = Intent(this, PlaybackService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
        bindService(intent, connection, Context.BIND_AUTO_CREATE)

        // Android 13+ 通知要授权；不给也照样播，只是通知栏看不到控制条
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onStart() {
        super.onStart()
        startFrames()
    }

    override fun onStop() {
        framing = false
        super.onStop()
    }

    override fun onDestroy() {
        service?.ui = null
        service?.onClose = null
        unbindService(connection)
        super.onDestroy()
    }

    // ---------- 每帧 ----------
    private val frame = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!framing) return
            val p = service?.player
            if (p != null && p.ready) {
                val (item, t) = p.here()
                if (item != null) tv.render(item, t, p.now(), p.upcoming(5))
            }
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    private fun startFrames() {
        if (framing || service == null) return
        framing = true
        Choreographer.getInstance().postFrameCallback(frame)
    }

    // ---------- 播放状态 ----------
    override fun onStatus(message: String?) = tv.setStatus(message)
    override fun onItemChanged(item: Item?) {}
    override fun onPausedChanged(paused: Boolean) = tv.setPaused(paused)

    // ---------- 交互 ----------
    override fun onScreenTap() { service?.userToggle() }
    override fun onGoLive() { service?.player?.goLive() }

    override fun onOpen(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: ActivityNotFoundException) {
        }
    }

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        val s = service
        val p = s?.player
        when (e.keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_SPACE,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> {
                if (e.action == KeyEvent.ACTION_UP) s?.userToggle(); return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY -> { if (e.action == KeyEvent.ACTION_UP) s?.userResume(); return true }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> { if (e.action == KeyEvent.ACTION_UP) s?.userPause(); return true }
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_L, KeyEvent.KEYCODE_MEDIA_NEXT -> {
                if (e.action == KeyEvent.ACTION_UP) p?.goLive(); return true
            }
        }
        return super.dispatchKeyEvent(e)
    }

    // 返回键 = 关掉电视（停播）；想后台听就按 Home
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        stopService(Intent(this, PlaybackService::class.java))
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }
}
