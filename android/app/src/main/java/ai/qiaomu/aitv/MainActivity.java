package ai.qiaomu.aitv;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AI 今天的 App 壳：一个全屏 WebView，打开就自动开机出声。
 *
 * 系统 WebView 够新（Chrome 105+，认 container query 单位等）就加载线上首页；
 * 老设备（比如停在 Chrome 61 的 Android 8 盒子/音箱）加载兼容版 /legacy/。
 * /legacy/ 的页面文件由 APK 自带（assets/legacy/），同源拦截返回；节目单、音频、配图仍然走线上。
 */
public class MainActivity extends Activity {
    static final String ORIGIN = "https://aitv.qiaomu.ai";
    static final String HOST = "aitv.qiaomu.ai";
    static final int MODERN_CHROME = 105;

    // 页面加载完自动开机：等播放器挂好，点一下「开机」（第四版画面是 .listen）。
    // App 里关掉了「播放需要手势」，所以这一下就能出声。
    static final String AUTO_START =
            "(function(){var n=0;(function go(){" +
            "var p=window.__aitv&&window.__aitv.player;" +
            "var b=document.querySelector('.tv:not([data-on]) .tv-power,.listen');" +
            "if(p&&b){b.click();return;}" +
            "if(p&&document.querySelector('.tv[data-on]'))return;" +
            "if(++n<600)setTimeout(go,100);})();})();";
    // 遥控器确定键 / 播放暂停键：没开机就开机，声音被拦了就点恢复，否则暂停/继续
    static final String TOGGLE =
            "(function(){var p=window.__aitv&&window.__aitv.player;if(!p)return;" +
            "var b=document.querySelector('.tv:not([data-on]) .tv-power,.listen');if(b){b.click();return;}" +
            "var r=document.getElementById('player-retry');if(r&&!r.hidden){r.click();return;}" +
            "if(p.paused)p.resume();else p.pause();})();";
    static final String PAUSE = "window.__aitv&&__aitv.player&&__aitv.player.pause();";
    static final String GO_LIVE = "window.__aitv&&__aitv.player&&__aitv.player.goLive();";

    private WebView web;
    private boolean stopped;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0a0a0b"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " AITV-Android/" + BuildConfig.VERSION_NAME);
        web.setWebViewClient(new Client());
        setContentView(web);
        hideSystemUi();

        web.loadUrl(startUrl());
    }

    private String startUrl() {
        String override = BuildConfig.DEBUG ? getIntent().getStringExtra("url") : null;
        if (override != null) return override;
        return ORIGIN + (chromeMajor() >= MODERN_CHROME ? "/" : "/legacy/");
    }

    private int chromeMajor() {
        Matcher m = Pattern.compile("Chrome/(\\d+)").matcher(WebSettings.getDefaultUserAgent(this));
        return m.find() ? Integer.parseInt(m.group(1)) : 0;
    }

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost()) || u.getPath() == null || !u.getPath().startsWith("/legacy/")) return null;
            String path = u.getPath().substring(1);
            if (path.endsWith("/")) path += "index.html";
            try {
                InputStream in = getAssets().open(path);
                return new WebResourceResponse(mime(path), "utf-8", in);
            } catch (IOException e) {
                return null; // APK 里没有就交给网络
            }
        }

        // 「看原文」等站外链接交给系统浏览器，播放器页面不被替换
        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri u = Uri.parse(url);
            if (HOST.equals(u.getHost()) || "localhost".equals(u.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            view.evaluateJavascript(AUTO_START, null);
        }
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        switch (e.getKeyCode()) {
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_SPACE:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                if (e.getAction() == KeyEvent.ACTION_UP) web.evaluateJavascript(TOGGLE, null);
                return true;
        }
        return super.dispatchKeyEvent(e);
    }

    // 离开 App 就停声；回来直接追到直播位置（这是直播台，不从离开处接着放）
    @Override
    protected void onStop() {
        super.onStop();
        stopped = true;
        web.evaluateJavascript(PAUSE, null);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (stopped) {
            stopped = false;
            web.evaluateJavascript(GO_LIVE, null);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    private void hideSystemUi() {
        if (Build.VERSION.SDK_INT < 19) return;
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
