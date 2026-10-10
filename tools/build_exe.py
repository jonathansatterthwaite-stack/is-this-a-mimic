"""Build dist/ITAMSapp.exe (Windows) with PyInstaller.

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
VERSION_FILE = os.path.join(BUILD, "version.txt")
APP_FILES = ["index.html", "manifest.webmanifest", "sw.js", "css", "js", "icons"]


def make_icon():
    from PIL import Image
    os.makedirs(BUILD, exist_ok=True)
    img = Image.open(os.path.join(ROOT, "icons", "icon-512.png"))
    img.save(ICO, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def app_version():
    """The release being built (publish.py passes it as MIMIC_VERSION), else 0.0.0."""
    v = os.environ.get("MIMIC_VERSION", "0.0.0").lstrip("v")
    parts = [int(x) if x.isdigit() else 0 for x in v.split(".")[:3]]
    return parts + [0] * (4 - len(parts))


def make_version_file():
    # The exe's Properties -> Details: who made it and what it is. (Unsigned exes without these
    # look more like malware to Windows Defender's heuristics.)
    v = app_version()
    dotted = ".".join(map(str, v))
    fields = {
        "CompanyName": "jonathansatterthwaite-stack",
        "FileDescription": "Is This A Mimic(s)? - an inventory manager for tabletop RPGs",
        "FileVersion": dotted,
        "InternalName": "ITAMSapp",
        "LegalCopyright": "Open source; includes SRD 5.1 material (CC BY 4.0)",
        "OriginalFilename": "ITAMSapp.exe",
        "ProductName": "Is This A Mimic(s)?",
        "ProductVersion": dotted,
    }
    strings = ",\n".join(f"        StringStruct({k!r}, {val!r})" for k, val in fields.items())
    with open(VERSION_FILE, "w", encoding="utf-8") as f:
        f.write(f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers={tuple(v)}, prodvers={tuple(v)}, mask=0x3f, flags=0x0, OS=0x40004,
    fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
{strings}
    ])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
""")


def main():
    make_icon()
    make_version_file()
    args = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", "ITAMSapp", "--icon", ICO, "--version-file", VERSION_FILE, "--noupx",
        "--distpath", os.path.join(ROOT, "dist"), "--workpath", BUILD, "--specpath", BUILD,
    ]
    for f in APP_FILES:
        src = os.path.join(ROOT, f)
        args += ["--add-data", f"{src}{os.pathsep}{f if os.path.isdir(src) else '.'}"]
    args.append(os.path.join(ROOT, "desktop.py"))
    subprocess.run(args, check=True, cwd=ROOT)
    exe = os.path.join(ROOT, "dist", "ITAMSapp.exe")
    print(f"\nBuilt {exe} ({os.path.getsize(exe) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
