// mp3 时长（Worker 里没有 ffprobe）：跳过 ID3v2，逐帧读帧头累加采样数。只认 Layer III。
const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
export function mp3Duration(b) {
  let p = 0;
  if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    p = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  }
  let secs = 0, frames = 0;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) { p++; continue; }
    const ver = (b[p + 1] >> 3) & 3, layer = (b[p + 1] >> 1) & 3, bri = b[p + 2] >> 4, sri = (b[p + 2] >> 2) & 3, pad = (b[p + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) { p++; continue; }
    const sr = SR[ver][sri], br = (ver === 3 ? BR1 : BR2)[bri] * 1000;
    const len = Math.floor(((ver === 3 ? 144 : 72) * br) / sr) + pad;
    if (len < 4) { p++; continue; }
    secs += (ver === 3 ? 1152 : 576) / sr; frames++;
    p += len;
  }
  return frames ? secs : 0;
}
