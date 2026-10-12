"""Generates the three icons: lite.ico (app / double-click), ide.ico, tgame-file.ico (the file type)."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "build")
os.makedirs(OUT, exist_ok=True)

ORANGE = (217, 144, 88, 255)
DARK = (30, 30, 30, 255)
PANEL = (45, 45, 48, 255)
LIGHT = (231, 231, 231, 255)
CYAN = (156, 220, 254, 255)


def font(size):
    for name in ("consolab.ttf", "consola.ttf", "cour.ttf", "arialbd.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def base(color):
    s = 1024                                            # draw big, shrink later
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((40, 40, s - 40, s - 40), radius=200, fill=color)
    return im, d, s


def centered(d, s, text, fnt, fill, dy=0):
    box = d.textbbox((0, 0), text, font=fnt)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((s - w) / 2 - box[0], (s - h) / 2 - box[1] + dy), text, font=fnt, fill=fill)


def lite():
    im, d, s = base(ORANGE)
    d.polygon([(380, 280), (380, 744), (790, 512)], fill=DARK)     # play triangle
    return im


def ide():
    im, d, s = base(PANEL)
    centered(d, s, "t", font(720), ORANGE, dy=-60)
    d.rectangle((330, 800, 694, 840), fill=CYAN)                     # caret underline
    return im


def doc():
    s = 1024
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    fold = 250
    d.polygon([(170, 40), (s - 170 - fold, 40), (s - 170, 40 + fold), (s - 170, s - 40), (170, s - 40)], fill=LIGHT)
    d.polygon([(s - 170 - fold, 40), (s - 170 - fold, 40 + fold), (s - 170, 40 + fold)], fill=(190, 190, 190, 255))
    d.rounded_rectangle((170, 600, s - 170, 900), radius=40, fill=ORANGE)
    centered(d, s, ".tgame", font(150), DARK, dy=300)
    d.polygon([(380, 250), (380, 520), (620, 385)], fill=ORANGE)
    return im


for name, fn in (("lite", lite), ("ide", ide), ("tgame-file", doc)):
    img = fn()
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
    img.save(os.path.join(OUT, name + ".ico"), sizes=sizes)
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, name + ".png"))
    print("wrote", name)
# electron-builder wants build/icon.ico for the installer itself
Image.open(os.path.join(OUT, "lite.png")).save(os.path.join(OUT, "icon.ico"), sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
