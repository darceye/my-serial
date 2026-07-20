#!/usr/bin/env python3
"""
MySerial 图标一键生成脚本
=========================
从单个 SVG 源文件生成 Tauri 项目所需的全部图标资源:
  - 各尺寸 PNG (32/64/128/256/512/1024 + Windows Store 磁贴)
  - icon.ico   (Windows 多尺寸 16/24/32/48/64/128/256)
  - favicon.ico(16/32/48)
  - icon.icns  (macOS)

仅依赖 Python 标准库 + ImageMagick (magick.exe) 作为外部光栅化工具。
Python 只负责编排: 参数以 list 形式传给 subprocess, 完全绕开 shell 转义。

用法:
    python build-icons.py                    # 默认 src-tauri/icons/icon.svg
    python build-icons.py path/to/source.svg # 指定 SVG 源
    python build-icons.py --jobs 1           # 串行 (调试用)
    python build-icons.py --dry-run          # 只打印命令, 不执行
"""

from __future__ import annotations

import os
import sys
import shutil
import subprocess
import argparse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# 项目根目录 (脚本所在目录)
ROOT = Path(__file__).resolve().parent
ICONS_DIR = ROOT / "src-tauri" / "icons"
PUBLIC_DIR = ROOT / "public"
DEFAULT_SVG = ICONS_DIR / "icon.svg"

# 渲染参数: 透明背景 + 高 DPI 光栅化 (避免小尺寸锯齿)
RENDER_OPTS = ["-background", "none", "-density", "300"]

# PNG 清单: (输出文件名, 像素尺寸)
PNG_TARGETS: list[tuple[str, int]] = [
    # --- 主图标 ---
    ("32x32.png", 32),
    ("64x64.png", 64),
    ("128x128.png", 128),
    ("128x128@2x.png", 256),
    ("icon.png", 512),
    ("source.png", 1024),
    # --- Windows Store / 磁贴 logo ---
    ("Square30x30Logo.png", 30),
    ("Square44x44Logo.png", 44),
    ("Square71x71Logo.png", 71),
    ("Square89x89Logo.png", 89),
    ("Square107x107Logo.png", 107),
    ("Square142x142Logo.png", 142),
    ("Square150x150Logo.png", 150),
    ("Square284x284Logo.png", 284),
    ("Square310x310Logo.png", 310),
    ("StoreLogo.png", 50),
]

# ICO 嵌入尺寸
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
FAVICON_SIZES = [16, 32, 48]


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #
def find_magick() -> str:
    """定位 magick.exe: 先 PATH, 再常见安装目录。"""
    exe = shutil.which("magick") or shutil.which("magick.exe")
    if exe:
        return exe
    # 常见安装路径
    glob_patterns = [
        r"C:\Program Files\ImageMagick-*\magick.exe",
        r"C:\Program Files (x86)\ImageMagick-*\magick.exe",
    ]
    import glob
    for pat in glob_patterns:
        hits = glob.glob(pat)
        if hits:
            return hits[0]
    raise FileNotFoundError(
        "未找到 ImageMagick (magick.exe)。\n"
        "请安装 ImageMagick 7: https://imagemagick.org/script/download.php#windows"
    )


def run(cmd: list[str], dry: bool = False) -> tuple[bool, str]:
    """运行命令, 返回 (成功?, 错误信息)。命令以 list 形式传递, 无 shell 转义。"""
    if dry:
        print(f"    [DRY] {' '.join(cmd)}")
        return True, ""
    try:
        # capture 只取 stderr (错误信息); stdout 一般无价值
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return False, (r.stderr or r.stdout or "").strip()
        return True, ""
    except subprocess.TimeoutExpired:
        return False, "timeout (120s)"
    except FileNotFoundError as e:
        return False, str(e)


def render_png(magick: str, svg: Path, name: str, size: int, dry: bool) -> tuple[str, bool, str]:
    """渲染单个 PNG。返回 (文件名, 成功?, 信息)。"""
    out = ICONS_DIR / name
    cmd = [magick, *RENDER_OPTS, str(svg), "-resize", f"{size}x{size}", str(out)]
    ok, err = run(cmd, dry)
    return (name, ok, err)


def clean_tauri_cache(dry: bool = False) -> int:
    """
    清理 Tauri 编译缓存中的图标产物, 强制 build.rs 重新嵌入新图标。
    删除:
      src-tauri/target/debug/build/my-serial-*
      src-tauri/target/debug/.fingerprint/my-serial-*
      src-tauri/target/release/build/my-serial-*
      src-tauri/target/release/.fingerprint/my-serial-*
    返回删除的目录数。
    """
    target = ROOT / "src-tauri" / "target"
    if not target.exists():
        return 0
    removed = 0
    for profile in ("debug", "release"):
        for subdir in ("build", ".fingerprint"):
            base = target / profile / subdir
            if not base.exists():
                continue
            for d in base.glob("my-serial-*"):
                if dry:
                    print(f"    [DRY] rmdir {d}")
                else:
                    shutil.rmtree(d, ignore_errors=True)
                removed += 1
    return removed


def render_ico(magick: str, svg: Path, out: Path, sizes: list[int], dry: bool) -> tuple[bool, str]:
    """
    生成多尺寸 ICO。
    思路: 先渲染最大尺寸的 PNG (中间文件), 再用 -clone 降采样生成各档,
    最后合并。中间 PNG 输出到临时文件, 避免参数里嵌入二进制。
    ImageMagick 7 的多尺寸 ICO 写法:
        magick max.png ( clone -resize 16 ) ( clone -resize 32 ) ... out.ico
    subprocess 传 list 时, 括号就是普通字符串元素, 无需转义。
    """
    # 中间文件: 用最大尺寸做母版
    max_size = max(sizes)
    tmp = out.with_suffix(".tmp.png")
    cmd_base = [magick, *RENDER_OPTS, str(svg), "-resize", f"{max_size}x{max_size}", str(tmp)]
    ok, err = run(cmd_base, dry)
    if not ok:
        return False, f"master render: {err}"

    # 各尺寸克隆 (除去母版本身)
    sub = sorted(set(sizes) - {max_size})
    clone_args = []
    for s in sub:
        clone_args += ["(", "-clone", "0", "-resize", f"{s}x{s}", ")"]
    # 保留最大尺寸那份, 把母版放最后; -clone 0 复制母版用于其它尺寸
    cmd_ico = [magick, str(tmp), *clone_args, str(out)]
    ok, err = run(cmd_ico, dry)
    if not dry and tmp.exists():
        tmp.unlink()
    return ok, err


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(
        description="从 SVG 生成 MySerial 项目所需的全部图标资源。"
    )
    parser.add_argument("svg", nargs="?", default=str(DEFAULT_SVG),
                        help=f"SVG 源文件 (默认: {DEFAULT_SVG})")
    parser.add_argument("--jobs", "-j", type=int, default=4,
                        help="并行渲染线程数 (默认: 4, 调试用 1)")
    parser.add_argument("--dry-run", action="store_true",
                        help="只打印命令不执行")
    args = parser.parse_args()

    svg = Path(args.svg).resolve()
    if not svg.exists():
        print(f"[ERROR] SVG 源文件不存在: {svg}")
        return 1

    try:
        magick = find_magick()
    except FileNotFoundError as e:
        print(f"[ERROR] {e}")
        return 1

    # 版本信息
    ver_ok, ver = run([magick, "-version"])
    print(f"[INFO] ImageMagick: {magick}")
    print(f"[INFO] SVG 源     : {svg}")
    print(f"[INFO] 输出目录   : {ICONS_DIR}")
    print(f"[INFO] 并行度     : {args.jobs}")
    print()

    # 准备目录
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    failures: list[str] = []

    # ---- 1. PNG (并行) ----
    print(f"=== 1/3 PNG ({len(PNG_TARGETS)} 个, 并行 x{args.jobs}) ===")
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futures = {
            ex.submit(render_png, magick, svg, name, size, args.dry_run): name
            for name, size in PNG_TARGETS
        }
        for fut in as_completed(futures):
            name, ok, err = fut.result()
            if ok:
                print(f"  [ OK ] {name}")
            else:
                print(f"  [FAIL] {name} -- {err}")
                failures.append(name)
    print()

    # ---- 2. ICO ----
    print("=== 2/3 ICO ===")
    ico_out = ICONS_DIR / "icon.ico"
    ok, err = render_ico(magick, svg, ico_out, ICO_SIZES, args.dry_run)
    status(ico_out, ok, err, failures)

    fav_out = PUBLIC_DIR / "favicon.ico"
    ok, err = render_ico(magick, svg, fav_out, FAVICON_SIZES, args.dry_run)
    status(fav_out, ok, err, failures)
    print()

    # ---- 3. ICNS ----
    print("=== 3/3 ICNS ===")
    icns_out = ICONS_DIR / "icon.icns"
    cmd = [magick, *RENDER_OPTS, str(svg), "-resize", "1024x1024", str(icns_out)]
    ok, err = run(cmd, args.dry_run)
    status(icns_out, ok, err, failures)
    print()

    # ---- 汇总 ----
    total = len(PNG_TARGETS) + 3
    print("=" * 60)
    if failures:
        print(f"  部分失败: {len(failures)}/{total} -> {', '.join(failures)}")
        print("=" * 60)
        return 1
    print(f"  完成! 全部 {total} 个图标已生成。")
    print()
    # ---- 清理 Tauri 图标缓存, 下次 build/dev 会重新嵌入新图标 ----
    print("--- 清理 Tauri 图标缓存 (强制 build.rs 重新嵌入新图标) ---")
    n = clean_tauri_cache(args.dry_run)
    if n:
        print(f"  [ OK ] 已清理 {n} 个缓存目录 (my-serial-* 的 build/.fingerprint)")
    else:
        print("  [SKIP] 无缓存可清 (target 目录不存在或已清)")
    print()
    print("  下次 npm run tauri dev / build 会自动嵌入新图标。")
    print("=" * 60)
    return 0


def status(path: Path, ok: bool, err: str, failures: list[str]) -> None:
    rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
    if ok:
        print(f"  [ OK ] {rel}")
    else:
        print(f"  [FAIL] {rel} -- {err}")
        failures.append(str(rel))


if __name__ == "__main__":
    sys.exit(main())
