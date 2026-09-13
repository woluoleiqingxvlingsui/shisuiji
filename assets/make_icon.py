# -*- coding: utf-8 -*-
"""生成「拾穗集」的可爱图标：编织小篮 + 金色麦穗 + 笑脸小蛋 + 一页小纸。
运行: python make_icon.py
输出: icon.ico (多尺寸 16-256)、icon-256.png、icon-512.png
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
FINAL = 512          # 主图尺寸
S = 4                # 超采样倍数，保证边缘平滑
W = FINAL * S

# ---- 配色 ----
BG = (173, 224, 240, 255)          # 柔和天蓝圆底
BROWN_LINE = (139, 94, 60, 255)    # 篮子深棕描边
BASKET = (217, 161, 94, 255)       # 篮身暖棕
BASKET_DARK = (185, 127, 68, 255)  # 编织纹深棕
RIM = (192, 138, 74, 255)          # 篮口唇色
INSIDE = (92, 58, 33, 255)         # 篮内暗色
WHEAT = (232, 184, 75, 255)        # 麦穗金
WHEAT_STEM = (196, 148, 52, 255)   # 麦茎
PAPER = (255, 253, 245, 255)       # 纸白
PAPER_LINE = (214, 206, 190, 255)  # 纸上横线
PAPER_EDGE = (205, 196, 178, 255)  # 纸描边
EGG = (255, 252, 240, 255)         # 蛋身奶白
EGG_EDGE = (235, 200, 150, 255)    # 蛋描边
FACE = (74, 59, 50, 255)           # 眼睛嘴巴


def sc(v):
    """设计稿按 512 坐标写，这里放大 S 倍。"""
    return v * S


img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
cx = cy = W / 2
d = ImageDraw.Draw(img)

# ---- 背景：柔和天蓝圆底 ----
bg_r = sc(242)
d.ellipse([cx - bg_r, cy - bg_r, cx + bg_r, cy + bg_r], fill=BG)


# ---- 背景装饰：白色小星星和小圆点 ----
def sparkle(dr, x, y, r, alpha=200):
    k = 0.28
    pts = [
        (x, y - r), (x + r * k, y - r * k), (x + r, y), (x + r * k, y + r * k),
        (x, y + r), (x - r * k, y + r * k), (x - r, y), (x - r * k, y - r * k),
    ]
    dr.polygon(pts, fill=(255, 255, 255, alpha))


def paste_center(base, im, x, y):
    base.alpha_composite(im, (int(x - im.size[0] / 2), int(y - im.size[1] / 2)))


deco = Image.new("RGBA", (W, W), (0, 0, 0, 0))
dd = ImageDraw.Draw(deco)
sparkle(dd, cx - sc(180), cy - sc(170), sc(24))
sparkle(dd, cx + sc(190), cy - sc(120), sc(16), 170)
sparkle(dd, cx - sc(210), cy + sc(30), sc(13), 150)
sparkle(dd, cx + sc(200), cy + sc(120), sc(15), 160)
dd.ellipse([cx + sc(150), cy - sc(205), cx + sc(166), cy - sc(189)], fill=(255, 255, 255, 150))
dd.ellipse([cx - sc(140), cy + sc(215), cx - sc(126), cy + sc(229)], fill=(255, 255, 255, 140))
img = Image.alpha_composite(img, deco)
d = ImageDraw.Draw(img)

# ---- 篮底柔和投影 ----
sh = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ds = ImageDraw.Draw(sh)
ds.ellipse([cx - sc(160), cy + sc(160), cx + sc(160), cy + sc(225)], fill=(96, 125, 139, 90))
sh = sh.filter(ImageFilter.GaussianBlur(sc(16)))
img = Image.alpha_composite(img, sh)
d = ImageDraw.Draw(img)

# ---- 篮子提手：大弧线（画在内容物后面） ----
d.arc([cx - sc(150), cy - sc(155), cx + sc(150), cy + sc(145)],
      start=180, end=360, fill=BROWN_LINE, width=sc(16))

# ---- 篮内开口：深色椭圆 ----
rim_cy = cy + sc(48)
rim_rx, rim_ry = sc(150), sc(40)
d.ellipse([cx - rim_rx, rim_cy - rim_ry, cx + rim_rx, rim_cy + rim_ry], fill=INSIDE)


# ---- 麦穗：沿茎密排金色籽粒（左右对生）+ 顶粒，整体呈细长纺锤形 ----
def grain_image(length, thick, color):
    g = Image.new("RGBA", (max(2, int(thick * 2)), max(2, int(length))), (0, 0, 0, 0))
    dg = ImageDraw.Draw(g)
    dg.ellipse([thick / 2, 0, thick * 1.5, length], fill=color, outline=BROWN_LINE, width=max(1, int(sc(1.4))))
    return g


def wheat(draw, base, x0, y0, x1, y1):
    draw.line([x0, y0, x1, y1], fill=WHEAT_STEM, width=sc(6))
    dx, dy = x1 - x0, y1 - y0
    L = math.hypot(dx, dy)
    ux, uy = dx / L, dy / L      # 茎方向
    px, py = -uy, ux             # 垂直方向
    base_ang = math.degrees(math.atan2(dy, dx))
    n = 7
    head = L * 0.42
    for i in range(n):
        t = 1 - (head * i / (n - 1)) / L          # 从穗尖往下排
        gx, gy = x0 + dx * t, y0 + dy * t
        gs = sc(30) * (1 - 0.35 * i / (n - 1))    # 越靠穗尖越小
        side = sc(8) * (1 - 0.4 * i / (n - 1))
        for s in (-1, 1):
            grain = grain_image(gs, gs * 0.44, WHEAT)
            # 长轴大致沿茎向、左右对称微外撇
            rot = base_ang + s * 26
            grain = grain.rotate(-rot, expand=True, resample=Image.BICUBIC)
            paste_center(base, grain, gx + px * s * side, gy + py * s * side)
    # 顶粒：沿茎向立一枚
    tip = grain_image(sc(34), sc(13), WHEAT)
    tip = tip.rotate(-(base_ang + 90), expand=True, resample=Image.BICUBIC)
    paste_center(base, tip, x1 + ux * sc(8), y1 + uy * sc(8))


# 左支麦穗：向右倾斜
wheat(d, img, cx + sc(30), rim_cy + sc(4), cx - sc(28), cy - sc(116))
# 右支麦穗：向左倾斜，略矮
wheat(d, img, cx + sc(62), rim_cy + sc(4), cx + sc(92), cy - sc(84))

# ---- 一页小白纸（右侧，微旋转） ----
pw, ph = int(sc(88)), int(sc(112))
paper = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
dp = ImageDraw.Draw(paper)
dp.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=sc(8), fill=PAPER, outline=PAPER_EDGE, width=max(1, int(sc(2))))
for i in range(4):
    y = sc(26) + i * sc(20)
    dp.line([sc(14), y, pw - sc(14), y], fill=PAPER_LINE, width=max(1, int(sc(3))))
paper = paper.rotate(14, expand=True, resample=Image.BICUBIC)
paste_center(img, paper, cx + sc(92), rim_cy - sc(48))


# ---- 笑脸小蛋（左侧，延续旧形象） ----
def egg_points(ox, oy, rx, ry, k=0.20, n=720):
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x = math.cos(t)
        y = math.sin(t)
        pts.append((ox + x * rx, oy + y * (1 + k * y) * ry))
    return pts


ecx, ecy = cx - sc(72), rim_cy - sc(66)
erx, ery = sc(64), sc(78)
egg = Image.new("RGBA", (W, W), (0, 0, 0, 0))
de = ImageDraw.Draw(egg)
de.polygon(egg_points(ecx, ecy, erx, ery), fill=EGG, outline=EGG_EDGE, width=sc(5))
# 蛋身高光：小而淡，贴左上边缘（大了会像秃斑）
hl = Image.new("RGBA", (W, W), (0, 0, 0, 0))
dh = ImageDraw.Draw(hl)
dh.ellipse([ecx - sc(52), ecy - sc(66), ecx - sc(26), ecy - sc(40)], fill=(255, 255, 255, 80))
hl = hl.filter(ImageFilter.GaussianBlur(sc(6)))
egg = Image.alpha_composite(egg, hl)
de = ImageDraw.Draw(egg)
# 眼睛 + 高光
for sx in (-1, 1):
    ex, ey = ecx + sx * sc(24), ecy + sc(6)
    de.ellipse([ex - sc(8), ey - sc(12), ex + sc(8), ey + sc(12)], fill=FACE)
    de.ellipse([ex - sc(4.5), ey - sc(7), ex - sc(0.5), ey - sc(3)], fill=(255, 255, 255, 255))
# 腮红
blush = Image.new("RGBA", (W, W), (0, 0, 0, 0))
db = ImageDraw.Draw(blush)
for sx in (-1, 1):
    bx, by = ecx + sx * sc(42), ecy + sc(22)
    db.ellipse([bx - sc(11), by - sc(7), bx + sc(11), by + sc(7)], fill=(255, 145, 165, 150))
blush = blush.filter(ImageFilter.GaussianBlur(sc(3)))
egg = Image.alpha_composite(egg, blush)
de = ImageDraw.Draw(egg)
# 微笑
de.arc([ecx - sc(13), ecy + sc(14), ecx + sc(13), ecy + sc(32)], start=20, end=160, fill=FACE, width=sc(5))
img = Image.alpha_composite(img, egg)
d = ImageDraw.Draw(img)

# ---- 篮口前唇：压住内容物的底部 ----
d.arc([cx - rim_rx, rim_cy - rim_ry, cx + rim_rx, rim_cy + rim_ry],
      start=12, end=168, fill=RIM, width=sc(22))


# ---- 篮身：圆角梯形 + 编织纹理 ----
def rounded_trapezoid(cxx, top_y, bot_y, top_w, bot_w, r, n=10):
    """顶宽 top_w、底宽 bot_w、底部圆角 r 的梯形点集。"""
    tl, tr = cxx - top_w / 2, cxx + top_w / 2
    bl, br = cxx - bot_w / 2, cxx + bot_w / 2
    pts = []
    # 顶边
    pts.append((tl + r, top_y))
    pts.append((tr - r, top_y))
    # 右侧斜边向下
    pts.append((br - r * 0.4, bot_y - r * 1.6))
    # 右下圆角
    for i in range(n + 1):
        a = math.pi / 2 * i / n          # 0→90°
        pts.append((br - r + r * math.cos(a) * 0 + r * math.sin(a) * 0 - r + r * math.cos(a),
                    bot_y - r + r * math.sin(a)))
    # 底边
    pts.append((bl + r, bot_y))
    # 左下圆角
    for i in range(n + 1):
        a = math.pi / 2 * i / n
        pts.append((bl + r - r * math.sin(a),
                    bot_y - r + r * math.cos(a)))
    # 左侧斜边回到顶部
    pts.append((tl + r * 0.4, top_y))
    return pts


body_top, body_bot = rim_cy + sc(14), rim_cy + sc(108)
body = Image.new("RGBA", (W, W), (0, 0, 0, 0))
dbody = ImageDraw.Draw(body)
body_pts = rounded_trapezoid(cx, body_top, body_bot, sc(292), sc(230), sc(34))
dbody.polygon(body_pts, fill=BASKET, outline=BROWN_LINE, width=sc(6))

# 编织纹理：横线 + 竖线，画在独立图层后用篮身形状裁切
weave = Image.new("RGBA", (W, W), (0, 0, 0, 0))
dw = ImageDraw.Draw(weave)
for i in range(2):
    y = body_top + sc(32) + i * sc(34)
    inset = sc(30) - i * sc(14)
    dw.line([cx - sc(146) + inset, y, cx + sc(146) - inset, y], fill=BASKET_DARK, width=sc(8))
step = sc(34)
x = cx - sc(128)
while x <= cx + sc(128):
    dw.line([x, body_top + sc(4), x, body_bot - sc(4)], fill=BASKET_DARK, width=sc(5))
    x += step
# 用篮身形状做蒙版裁切纹理
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).polygon(body_pts, fill=255)
body.paste(weave, (0, 0), Image.composite(weave.split()[3], Image.new("L", (W, W), 0), mask).point(lambda v: 255 if v > 10 else 0))
img = Image.alpha_composite(img, body)
d = ImageDraw.Draw(img)

# ---- 缩小出图并保存 ----
master = img.resize((FINAL, FINAL), Image.LANCZOS)
master.save(os.path.join(HERE, "icon-512.png"))
master.resize((256, 256), Image.LANCZOS).save(os.path.join(HERE, "icon-256.png"))
master.save(
    os.path.join(HERE, "icon.ico"),
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("saved icon.ico / icon-256.png / icon-512.png in", HERE)
