// "Call me" intent for the text agent (Wei, 2026-11-17): when the owner
// asks for a call in chat, the agent dials — no human in the loop.
// Kept narrow on purpose: reports about calls ("I called you yesterday",
// "did you call Rio") must NOT dial.
const EN = /\b(call me|give me a call|ring me|call me back|can you call me|please call me)\b/i;
const ZH = /(打给我|给我打电话|给我打个电话|打电话给我|拨给我|回我电话)/;
export function callIntent(text) {
  const t = String(text || '');
  return EN.test(t) || ZH.test(t);
}
export const isZh = (text) => /[\u4e00-\u9fff]/.test(String(text || ''));
