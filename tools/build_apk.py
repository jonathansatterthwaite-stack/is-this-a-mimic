"""Build dist/ITAMSapp.apk (Android) without Gradle or Android Studio.

Uses the Android SDK command-line build tools directly:
aapt2 (resources) -> javac -> d8 (dex) -> zipalign -> apksigner.

    python tools/build_apk.py

Toolchain location: the MIMIC_ANDROID_TOOLCHAIN environment variable, or
../android-toolchain next to this project. It must contain a JDK 17
(jdk-17*), and sdk/ with platforms;android-34 and build-tools;34.0.0.

The APK is signed with android/keystore/packrat.keystore, which is created on
the first build. Keep that file: Android only installs updates signed with
the same key.
"""
import glob
import os
import secrets
import shutil
import subprocess
import sys
import zipfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANDROID = os.path.join(ROOT, "android")
BUILD = os.path.join(ANDROID, ".build")
DIST = os.path.join(ROOT, "dist")
TOOLCHAIN = os.environ.get("MIMIC_ANDROID_TOOLCHAIN") or os.path.join(os.path.dirname(ROOT), "android-toolchain")
SDK = os.path.join(TOOLCHAIN, "sdk")
BUILD_TOOLS = os.path.join(SDK, "build-tools", "34.0.0")
ANDROID_JAR = os.path.join(SDK, "platforms", "android-34", "android.jar")
KEYSTORE_DIR = os.path.join(ANDROID, "keystore")

APP_FILES = ["index.html", "manifest.webmanifest", "sw.js", "css", "js", "icons"]
VERSION_CODE = 1
VERSION_NAME = "1.0"
MIN_SDK, TARGET_SDK = 24, 34
ICON_SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def jdk():
    found = sorted(glob.glob(os.path.join(TOOLCHAIN, "jdk-17*")))
    if not found:
        sys.exit(f"No JDK 17 found in {TOOLCHAIN}")
    return found[-1]


def env():
    e = dict(os.environ)
    e["JAVA_HOME"] = jdk()
    e["PATH"] = os.path.join(jdk(), "bin") + os.pathsep + e["PATH"]
    tmp = os.path.join(TOOLCHAIN, "tmp")  # keep temp files off a nearly-full C: drive
    os.makedirs(tmp, exist_ok=True)
    e["TEMP"] = e["TMP"] = tmp
    return e


def run(*args):
    shown = ["****" if prev in ("-storepass", "-keypass") else "pass:****" if a.startswith("pass:") else a
             for prev, a in zip(("",) + args, args)]
    print("  $", os.path.basename(shown[0]), *[a if len(a) < 60 else "…" + a[-40:] for a in shown[1:6]], "…" if len(args) > 6 else "")
    subprocess.run(list(args), check=True, env=env())


def tool(name):
    for ext in ("", ".exe", ".bat"):
        p = os.path.join(BUILD_TOOLS, name + ext)
        if os.path.exists(p):
            return p
    sys.exit(f"Missing build tool {name} in {BUILD_TOOLS}")


def keystore():
    """Create the signing key on first use; returns (path, password)."""
    ks = os.path.join(KEYSTORE_DIR, "packrat.keystore")
    pw_file = os.path.join(KEYSTORE_DIR, "keystore-password.txt")
    if os.path.exists(ks) and os.path.exists(pw_file):
        return ks, open(pw_file).read().strip()
    os.makedirs(KEYSTORE_DIR, exist_ok=True)
    pw = secrets.token_urlsafe(18)
    run(os.path.join(jdk(), "bin", "keytool.exe"), "-genkeypair", "-keystore", ks, "-storepass", pw, "-keypass", pw,
        "-alias", "packrat", "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000",
        "-dname", "CN=Pack Rat, O=Pack Rat")
    with open(pw_file, "w") as f:
        f.write(pw + "\n")
    with open(os.path.join(KEYSTORE_DIR, "README.txt"), "w") as f:
        f.write("Signing key for ITAMSapp.apk (it replaced PackRat.apk, then IsThisAMimic.apk: the same key, so it installs over it). Keep both files and back them up:\n"
                "Android only installs updates signed with the same key. Don't share them.\n")
    return ks, pw


def main():
    for p in (ANDROID_JAR, BUILD_TOOLS):
        if not os.path.exists(p):
            sys.exit(f"Android SDK piece missing: {p}")
    shutil.rmtree(BUILD, ignore_errors=True)
    os.makedirs(BUILD)

    # 1. Web app -> assets/www, served to the WebView by PartyServer
    www = os.path.join(BUILD, "assets", "www")
    for f in APP_FILES:
        src = os.path.join(ROOT, f)
        dst = os.path.join(www, f)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)

    # 2. Resources + launcher icons generated from the app icon
    res = os.path.join(BUILD, "res")
    shutil.copytree(os.path.join(ANDROID, "res"), res)
    icon = Image.open(os.path.join(ROOT, "icons", "icon-512.png")).convert("RGBA")
    for density, size in ICON_SIZES.items():
        d = os.path.join(res, f"mipmap-{density}")
        os.makedirs(d, exist_ok=True)
        icon.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher.png"))

    print("Compiling resources")
    compiled = os.path.join(BUILD, "res.zip")
    run(tool("aapt2"), "compile", "--dir", res, "-o", compiled)
    base = os.path.join(BUILD, "base.apk")
    gen = os.path.join(BUILD, "gen")
    run(tool("aapt2"), "link", "-o", base, "-I", ANDROID_JAR, "--manifest", os.path.join(ANDROID, "AndroidManifest.xml"),
        "-A", os.path.join(BUILD, "assets"), "--java", gen, "--min-sdk-version", str(MIN_SDK),
        "--target-sdk-version", str(TARGET_SDK), "--version-code", str(VERSION_CODE), "--version-name", VERSION_NAME,
        "--auto-add-overlay", compiled)

    print("Compiling Java")
    classes = os.path.join(BUILD, "classes")
    os.makedirs(classes)
    sources = glob.glob(os.path.join(ANDROID, "src", "**", "*.java"), recursive=True) + \
        glob.glob(os.path.join(gen, "**", "*.java"), recursive=True)
    run(os.path.join(jdk(), "bin", "javac.exe"), "-source", "8", "-target", "8", "-Xlint:-options", "-encoding", "UTF-8",
        # core-lambda-stubs supplies LambdaMetafactory, which android.jar lacks; d8 desugars the lambdas.
        "-bootclasspath", ANDROID_JAR + os.pathsep + os.path.join(BUILD_TOOLS, "core-lambda-stubs.jar"),
        "-d", classes, *sources)

    print("Converting to DEX")
    dex_dir = os.path.join(BUILD, "dex")
    os.makedirs(dex_dir)
    class_files = glob.glob(os.path.join(classes, "**", "*.class"), recursive=True)
    run(tool("d8"), "--release", "--min-api", str(MIN_SDK), "--lib", ANDROID_JAR, "--output", dex_dir, *class_files)

    print("Packaging")
    unsigned = os.path.join(BUILD, "unsigned.apk")
    # A fresh archive with aapt2's entries copied as they were (resources.arsc stays uncompressed)
    # plus the code. Appending to aapt2's zip instead leaves headers zipalign complains about.
    with zipfile.ZipFile(base) as src, zipfile.ZipFile(unsigned, "w") as z:
        for info in src.infolist():
            entry = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            entry.compress_type = info.compress_type
            entry.external_attr = info.external_attr
            z.writestr(entry, src.read(info.filename))
        z.write(os.path.join(dex_dir, "classes.dex"), "classes.dex", compress_type=zipfile.ZIP_DEFLATED)
    aligned = os.path.join(BUILD, "aligned.apk")
    run(tool("zipalign"), "-f", "-p", "4", unsigned, aligned)

    print("Signing")
    ks, pw = keystore()
    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, "ITAMSapp.apk")
    run(tool("apksigner"), "sign", "--ks", ks, "--ks-pass", f"pass:{pw}", "--ks-key-alias", "packrat",
        "--min-sdk-version", str(MIN_SDK), "--out", out, aligned)
    run(tool("apksigner"), "verify", "--min-sdk-version", str(MIN_SDK), out)
    for leftover in glob.glob(out + ".idsig"):
        os.remove(leftover)
    print(f"\nBuilt {out} ({os.path.getsize(out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
