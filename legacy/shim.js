// 老 WebView 不认 container query 单位（1cqw）和 aspect-ratio。
// 画面里所有尺寸都是 em，基准是 .tv-picture 的 font-size = 屏幕宽度的 1%。这里用 JS 算出来写回去。
// 遥控/小屏设备没有机身边框的必要：.tv-screen 铺满视口，按 16:9 能放下的最大尺寸取基准。
(function () {
  var root = document.documentElement;
  function fit() {
    var w = root.clientWidth, h = root.clientHeight;
    var unit = Math.min(w, h * 16 / 9) / 100;
    root.style.setProperty("--cqw", unit + "px");
  }
  fit();
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", fit);

  // 点开机时顺手进全屏（浏览器顶栏会吃掉三分之一的小屏）。不支持就算了。
  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest(".tv-power")) return;
    var req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (req && !(document.fullscreenElement || document.webkitFullscreenElement)) {
      try { var p = req.call(root); if (p && p.catch) p.catch(function () {}); } catch (err) {}
    }
  }, true);
})();
