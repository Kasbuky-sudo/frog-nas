#!/usr/bin/env python3
"""从源图生成 fnOS 应用图标（5 个尺寸）。

源图: packaging/fnOS/assets/icon-source.png
      方形、边长 >=512px。白底不透明即可 —— fnOS 的应用图标本来就惯用
      白底方图（本地已验证：真机装成功的 MiyoQian 图标四角是 254,254,254
      且 alpha 全 255），所以不需要抠透明底，抠了反而和别的应用不一致。

产出:
    packaging/fnOS/ICON.PNG                    64x64    包根图标
    packaging/fnOS/ICON_256.PNG                256x256  包根图标
    packaging/fnOS/ui/images/icon_64.png       64x64    桌面入口
    packaging/fnOS/ui/images/icon_128.png      128x128  桌面入口
    packaging/fnOS/ui/images/icon_256.png      256x256  桌面入口

不要手工往上面几个路径塞图 —— 改源图再重跑本脚本，否则下次打包就被覆盖回去。

用法:
    python packaging/fnOS/scripts/make-icons.py
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('需要 Pillow: pip install Pillow')

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(PKG, 'assets', 'icon-source.png')

TARGETS = [
    (os.path.join(PKG, 'ICON.PNG'), 64),
    (os.path.join(PKG, 'ICON_256.PNG'), 256),
    (os.path.join(PKG, 'ui', 'images', 'icon_64.png'), 64),
    (os.path.join(PKG, 'ui', 'images', 'icon_128.png'), 128),
    (os.path.join(PKG, 'ui', 'images', 'icon_256.png'), 256),
]


def main():
    if not os.path.isfile(SOURCE):
        sys.exit('找不到源图: %s' % SOURCE)

    src = Image.open(SOURCE)
    w, h = src.size
    if w != h:
        sys.exit('源图必须是正方形，当前 %dx%d。请自行裁剪后重跑。' % (w, h))
    if w < 256:
        sys.exit('源图太小（%dpx）。至少 256px，建议 512 或 1024。' % w)

    src = src.convert('RGBA')
    for path, size in TARGETS:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        src.resize((size, size), Image.LANCZOS).save(path, 'PNG', optimize=True)
        print('%-46s %dx%d' % (os.path.relpath(path, os.path.dirname(PKG)), size, size))

    print('\n源图 %dx%d -> 5 个尺寸完成' % (w, h))


if __name__ == '__main__':
    main()
