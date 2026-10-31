#!/usr/bin/env python3
"""帳票PDF用の日本語フォントを作る（再現用）。
元: Noto Sans JP Regular（npm: @expo-google-fonts/noto-sans-jp 0.4.4 の NotoSansJP_400Regular.ttf。SIL OFL 1.1）
加工: 業務書類に必要な文字（JIS X 0208 + Windows拡張[髙・﨑・㈱ など]、ラテン、記号）だけに絞る。
      OFLの規定（加工したものは、予約された名前を使わない）に従い、フォント名を変更する。
使い方: python3 scripts/build_pdf_font.py <元のNotoSansJP_400Regular.ttf> web/public/fonts/CrosstechSansJP-Regular.ttf
必要: pip install fonttools
"""
import subprocess, sys, tempfile, os

src, dst = sys.argv[1], sys.argv[2]
chars = set()
for b1 in range(0x81, 0xFD):                       # CP932（Shift_JIS + NEC/IBM拡張）の2バイト文字
    for b2 in range(0x40, 0xFD):
        try: chars.add(ord(bytes([b1, b2]).decode("cp932")))
        except Exception: pass
for b1 in range(0xA1, 0xFF):                       # JIS X 0208（EUC-JP）
    for b2 in range(0xA1, 0xFF):
        try: chars.add(ord(bytes([b1, b2]).decode("euc_jp")))
        except Exception: pass
for a, b in [(0x20, 0x7E), (0xA0, 0xFF), (0x2010, 0x2027), (0x2030, 0x203B), (0x2190, 0x2199), (0x2460, 0x2473),
             (0x25A0, 0x25FF), (0x3000, 0x30FF), (0x31F0, 0x31FF), (0xFF00, 0xFFEF)]:
    chars.update(range(a, b + 1))
chars.discard(0x7F)

with tempfile.TemporaryDirectory() as d:
    uni = os.path.join(d, "u.txt"); open(uni, "w").write(",".join("U+%04X" % c for c in sorted(chars)))
    tmp = os.path.join(d, "sub.ttf")
    subprocess.check_call(["pyftsubset", src, f"--unicodes-file={uni}", "--layout-features=", "--no-hinting",
                           "--desubroutinize", "--notdef-outline", f"--output-file={tmp}"])
    from fontTools.ttLib import TTFont
    f = TTFont(tmp)
    for rec in f["name"].names:                      # 名前を変更（1:ファミリー 4:フルネーム 6:PostScript名 16/17/21/22/25 は削除）
        if rec.nameID == 1: rec.string = "Crosstech Sans JP"
        elif rec.nameID == 4: rec.string = "Crosstech Sans JP Regular"
        elif rec.nameID == 6: rec.string = "CrosstechSansJP-Regular"
    f["name"].names = [r for r in f["name"].names if r.nameID not in (16, 17, 21, 22, 25)]
    f.save(dst)
print("文字数:", len(chars), "→", dst, os.path.getsize(dst), "bytes")
