const dialog = document.getElementById('site-dialog');
const content = {
  follow: { title: '关注向阳乔木', image: '/assets/qiaomu_wechat_public_account_qr.jpg', note: '微信公众号：向阳乔木推荐看' },
  reward: { title: '打赏支持', image: '/assets/qiaomu_reward_qr.png', note: '感谢支持 AI 今天' },
};
document.querySelectorAll('[data-modal]').forEach(button => button.addEventListener('click', () => {
  const info = content[button.dataset.modal];
  document.getElementById('dialog-title').textContent = info.title;
  const image = document.getElementById('dialog-qr'); image.src = info.image; image.alt = info.note;
  document.getElementById('dialog-note').textContent = info.note;
  dialog.showModal();
}));
dialog.querySelector('button').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) {
  const r = dialog.getBoundingClientRect();
  if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
} });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
