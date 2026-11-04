#!/usr/bin/env python3
"""Збирання ThinCap 140 в один офлайн-HTML.

Вбудовує: шрифти (base64 woff2, latin + cyrillic), логотип (inline SVG), app.js і дані кейсу.

  python3 build.py                                   # демо-версія -> dist/thincap-140.html
  python3 build.py --case cases/<кейс>.case.json --out cases/<кейс>.html   # версія з даними клієнта (не комітиться)
"""
import argparse, base64, json, pathlib, re

FONTS = [  # (family, style, file, unicode-range)
    ("Manrope", "normal", "manrope-latin-wght-normal.woff2", "latin"),
    ("Manrope", "normal", "manrope-cyrillic-wght-normal.woff2", "cyrillic"),
    ("Playfair Display", "normal", "playfair-display-latin-wght-normal.woff2", "latin"),
    ("Playfair Display", "normal", "playfair-display-cyrillic-wght-normal.woff2", "cyrillic"),
    ("Playfair Display", "italic", "playfair-display-latin-wght-italic.woff2", "latin"),
    ("Playfair Display", "italic", "playfair-display-cyrillic-wght-italic.woff2", "cyrillic"),
    ("JetBrains Mono", "normal", "jetbrains-mono-latin-wght-normal.woff2", "latin"),
    ("JetBrains Mono", "normal", "jetbrains-mono-cyrillic-wght-normal.woff2", "cyrillic"),
]
RANGES = {
    "latin": "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    "cyrillic": "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116",
}
WEIGHTS = {"Manrope": "200 800", "Playfair Display": "400 900", "JetBrains Mono": "100 800"}


def b64(p: pathlib.Path) -> str:
    return base64.b64encode(p.read_bytes()).decode()


def main():
    ap = argparse.ArgumentParser()
    root = pathlib.Path(__file__).parent
    ap.add_argument("--fonts", default=str(root / "vendor/fonts"))
    ap.add_argument("--brand", default=str(root / "brand"))
    ap.add_argument("--case", default=str(root / "src/demo.case.json"))
    ap.add_argument("--out", default=str(root / "dist/thincap-140.html"))
    a = ap.parse_args()
    fonts_dir, brand = pathlib.Path(a.fonts), pathlib.Path(a.brand)

    faces = []
    for fam, style, fn, rng in FONTS:
        f = next(fonts_dir.rglob(fn))
        faces.append(
            f'@font-face{{font-family:"{fam}";font-style:{style};font-display:swap;font-weight:{WEIGHTS[fam]};'
            f'src:url(data:font/woff2;base64,{b64(f)}) format("woff2-variations"),url(data:font/woff2;base64,{b64(f)}) format("woff2");'
            f'unicode-range:{RANGES[rng]}}}'
        )
    # один src достатньо; другий рядок прибираємо, щоб не дублювати розмір
    faces = [re.sub(r',url\(data:font/woff2;base64,[^)]+\) format\("woff2"\)', "", x) for x in faces]

    svg = (brand / "assets/logo/logo-green.svg").read_text(encoding="utf-8")
    svg = re.sub(r"<\?xml[^>]*\?>", "", svg).strip()
    svg = re.sub(r'\sid="[^"]*"', "", svg)
    svg = svg.replace("<svg ", '<svg class="logo" role="img" aria-label="Логотип ТОВ АФ «Алекс С. Аудит»" ', 1)

    html = (root / "src/app.html").read_text(encoding="utf-8")
    js = (root / "src/app.js").read_text(encoding="utf-8")
    # синтаксична перевірка до збирання (потрібен node; якщо його немає — пропускаємо)
    import shutil, subprocess
    if shutil.which("node"):
        chk = subprocess.run(["node", "--check", str(root / "src/app.js")], capture_output=True, text=True)
        if chk.returncode != 0:
            raise SystemExit("Помилка синтаксису в src/app.js:\n" + chk.stderr)
    case = json.loads(pathlib.Path(a.case).read_text(encoding="utf-8"))
    case_js = json.dumps(case, ensure_ascii=False).replace("</", "<\\/")  # безпечно всередині <script>
    js = js.replace("/*@@CASE@@*/null", case_js)
    html = (html.replace("/*@@FONTS@@*/", "\n".join(faces))
                .replace("@@LOGO@@", svg)
                .replace("/*@@APPJS@@*/", js))
    assert "@@" not in html, "не всі плейсхолдери замінено"
    out = pathlib.Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"{a.out}: {len(html.encode())/1024:.0f} КБ")


if __name__ == "__main__":
    main()
