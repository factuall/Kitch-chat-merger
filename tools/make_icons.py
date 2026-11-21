"""Generates the extension icons: white "K" with a black outline on a rounded square split diagonally
into Twitch purple (top-left) and Kick green (bottom-right).

Usage: python tools/make_icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

TWITCH_PURPLE = (145, 70, 255, 255)  # #9146FF
KICK_GREEN = (83, 252, 24, 255)      # #53FC18
WHITE = (255, 255, 255, 255)
BLACK = (0, 0, 0, 255)
SIZES = [16, 32, 48, 128]
SUPERSAMPLE = 8
FONT = 'arialbd.ttf'

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')


def make_icon(size):
    s = size * SUPERSAMPLE
    radius = round(s * 0.22)

    # Diagonal split, top-right to bottom-left.
    bg = Image.new('RGBA', (s, s), KICK_GREEN)
    ImageDraw.Draw(bg).polygon([(0, 0), (s, 0), (0, s)], fill=TWITCH_PURPLE)

    # Rounded-square mask.
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    icon = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)

    # Centered white K.
    draw = ImageDraw.Draw(icon)
    font = ImageFont.truetype(FONT, round(s * 0.74))
    # Outline width scales with the icon, but stays visible at 16 px.
    stroke = max(round(s * 0.035), SUPERSAMPLE)
    left, top, right, bottom = draw.textbbox((0, 0), 'K', font=font, stroke_width=stroke)
    x = (s - (right - left)) / 2 - left
    y = (s - (bottom - top)) / 2 - top
    draw.text((x, y), 'K', font=font, fill=WHITE, stroke_width=stroke, stroke_fill=BLACK)

    return icon.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f'icon{size}.png')
        make_icon(size).save(path)
        print('wrote', os.path.normpath(path))


if __name__ == '__main__':
    main()
