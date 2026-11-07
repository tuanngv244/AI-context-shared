function prefix(text: string, bytes: number) {
  let used = 0,
    result = '';
  for (const char of text) {
    const cost = Buffer.byteLength(char);
    if (used + cost > bytes) break;
    used += cost;
    result += char;
  }
  return result;
}
export function fitMemory(item: any, maxBytes: number) {
  if (Buffer.byteLength(JSON.stringify(item)) <= maxBytes) return item;
  const overhead =
    Buffer.byteLength(JSON.stringify({ ...item, summary: '', summaryTruncated: true })) + 40;
  const available = maxBytes - overhead;
  if (available < 100) return item; // The final bundle packer will skip an oversized metadata envelope.
  const marker = '\n[… rút gọn theo context budget …]\n';
  const textBytes = available - Buffer.byteLength(marker);
  const head = prefix(item.summary, Math.floor(textBytes * 0.65));
  const reversed = [...item.summary].reverse().join('');
  const tail = [...prefix(reversed, Math.floor(textBytes * 0.35))].reverse().join('');
  return { ...item, summary: head + marker + tail, summaryTruncated: true };
}
