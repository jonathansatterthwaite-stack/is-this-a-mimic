"""Build dist/IsThisAMimic.exe (Windows) with PyInstaller.

    python -m pip install pyinstaller pillow
    python tools/build_exe.py

The exe bundles the web app plus desktop.py/server.py; nothing else is needed
on the target PC (it opens in Edge or Chrome app mode, which Windows has).
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "tools", ".build")
ICO = os.path.join(BUILD, "mimic.ico")
APP_FILES = ["index.html", "manifest.webmanifest", "sw.js", "css", "js", "icons"]


def make_icon():
    from PIL import Image
    os.makedirs(BUILD, exist_ok=True)
    img = Image.open(os.path.join(ROOT, "icons", "icon-512.png"))
    img.save(ICO, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def main():
    make_icon()
    args = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", "IsThisAMimic", "--icon", ICO,
        "--distpath", os.path.join(ROOT, "dist"), "--workpath", BUILD, "--specpath", BUILD,
    ]
    for f in APP_FILES:
        src = os.path.join(ROOT, f)
        args += ["--add-data", f"{src}{os.pathsep}{f if os.path.isdir(src) else '.'}"]
    args.append(os.path.join(ROOT, "desktop.py"))
    subprocess.run(args, check=True, cwd=ROOT)
    exe = os.path.join(ROOT, "dist", "IsThisAMimic.exe")
    print(f"\nBuilt {exe} ({os.path.getsize(exe) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
