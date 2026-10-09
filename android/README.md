# AI 今天 · Android App

一个全屏 WebView 壳，给不方便操作浏览器的设备（电视盒子、触屏音箱、旧手机）一个「点开就播」的入口。

- minSdk 21（Android 5.0），纯 Java + 系统 WebView，无 AndroidX / 第三方依赖
- 系统 WebView 是 Chrome 105+：加载 `https://aitv.qiaomu.ai/`；更老：加载 `/legacy/` 兼容版
- `/legacy/` 的页面文件（`public/legacy/`，由 `npm run build` 生成）打包进 APK，`shouldInterceptRequest` 同源返回；`/api/*`、`/audio/*`、`/img/*` 仍走线上
- 打开即自动开机出声（App 内关闭了「播放需要用户手势」），屏幕常亮，沉浸式全屏
- 遥控器：确定 / Enter / 空格 / 播放暂停键 → 开机、恢复声音或暂停/继续
- 离开 App 停声；回到 App 追到直播位置
- 「看原文」等站外链接交给系统浏览器
- 出现在手机桌面和 Android TV 启动器（带横幅）

## 构建

```bash
# 仓库根目录
npm install
npm run android
# → android/app/build/outputs/apk/release/app-release.apk
```

需要 JDK 17+（Android Studio 自带的 JBR 即可）和 Android SDK 34。SDK 路径写在 `android/local.properties`（`sdk.dir=...`）或环境变量 `ANDROID_HOME`。

正式签名用环境变量：`AITV_KEYSTORE`、`AITV_KEYSTORE_PASSWORD`、`AITV_KEY_ALIAS`、`AITV_KEY_PASSWORD`。没配置时 release 包用 debug 签名，可以直接安装测试。

## 调试

debug 包（`./gradlew assembleDebug`，包名 `ai.qiaomu.aitv.debug`）开启 WebView 远程调试，并允许用 `url` 参数指向本地预览：

```bash
npm run legacy:serve                     # 本地兼容版，API/音频转发到线上
adb reverse tcp:8788 tcp:8788
adb shell am start -n ai.qiaomu.aitv.debug/ai.qiaomu.aitv.MainActivity -e url http://localhost:8788/legacy/
```

在电脑 Chrome 打开 `chrome://inspect` 可以看到 App 里的页面。

## 已验证设备

| 设备 | 系统 / WebView | 结果 |
|---|---|---|
| 小米 LX04（小爱触屏音箱，800×480） | Android 8.1 / Chrome 61 | 兼容版自动开机播放、音画同步、熄屏亮屏后回到直播 |
