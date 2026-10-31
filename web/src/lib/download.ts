/** ファイルとして保存する。リンクを画面に付けて押し、URLは少し待ってから無効にする（ブラウザによって、ファイル名が落ちたり保存に失敗したりするのを防ぐ）。 */
export function saveBlob(data: BlobPart, name: string, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
