"""Publish Is This A Mimic? to its public GitHub repository.

    python tools/publish.py [-m MESSAGE]   stage, commit and push (the Pages site redeploys)
    python tools/publish.py --release      ...then build IsThisAMimic.exe and .apk and publish a release
        [--version X.Y.Z]                  its version (default: the next minor one, v1.0.0 for the first)
        [--title TEXT]                     added to the release's title (e.g. "BIG CHANGE: drawn icons")
        [--notes FILE]                     Markdown shown at the top of the release notes

The public copy lives in ../is-this-a-mimic, a clone of the repository. It gets the
project's files minus private and local ones (the signing keystore, dist/,
caches, party data), with the item data rebuilt as SRD 5.1 content only.
The release builds are made from that copy, so they carry the same data. The
keystore is copied in for signing the APK but is ignored by git and checked
again before every commit.
"""
import datetime
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STAGE = os.path.join(os.path.dirname(ROOT), "is-this-a-mimic")
REPO = "jonathansatterthwaite-stack/is-this-a-mimic"
AUTHOR = ("jonathansatterthwaite-stack", "231256534+jonathansatterthwaite-stack@users.noreply.github.com")

PUBLISH = ["index.html", "manifest.webmanifest", "sw.js", "css", "js", "icons", "site", ".github", ".gitignore", ".gitattributes",
           "server.py", "desktop.py", "start-party.bat", "README.md", "android", "tools"]
SKIP_DIRS = {"keystore", ".cache", ".build", "__pycache__"}
# Files edited on GitHub itself: the repository's copy is kept as it is (and copied into the
# project for reference), never replaced from the project.
GITHUB_OWNED = ["planned-updates.md"]
# Kept in the stage between runs: local-only things (never committed; see .gitignore) and the above.
KEEP = {".git", "dist", "tools/.build", "tools/.cache", "android/keystore", *GITHUB_OWNED}
PRIVATE = ("keystore", ".keystore", "password")


def run(*args, cwd=STAGE, capture=False):
    r = subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=capture)
    return r.stdout.strip() if capture else None


def git(*args, capture=False):
    return run("git", *args, capture=capture)


def stage():
    if not os.path.isdir(os.path.join(STAGE, ".git")):
        run("gh", "repo", "clone", REPO, STAGE, cwd=os.path.dirname(ROOT))
    git("config", "user.name", AUTHOR[0])
    git("config", "user.email", AUTHOR[1])
    # Take anything committed on GitHub since the last publish (edits made on the website).
    if git("ls-remote", "--heads", "origin", "main", capture=True):
        git("pull", "-q", "--ff-only", "origin", "main")
    else:  # (a new, empty repository: it starts with the project's copies of GitHub's files)
        for name in GITHUB_OWNED:
            if os.path.exists(os.path.join(ROOT, name)):
                shutil.copy2(os.path.join(ROOT, name), os.path.join(STAGE, name))
    for name in GITHUB_OWNED:
        if os.path.exists(os.path.join(STAGE, name)):
            shutil.copy2(os.path.join(STAGE, name), os.path.join(ROOT, name))
    # Start clean (deleted files disappear from the repo too), keeping only the local-only folders.
    for name in os.listdir(STAGE):
        path = os.path.join(STAGE, name)
        if name in KEEP:
            continue
        if name in ("tools", "android") and os.path.isdir(path):
            for sub in os.listdir(path):
                if f"{name}/{sub}" not in KEEP:
                    p = os.path.join(path, sub)
                    shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
            continue
        shutil.rmtree(path) if os.path.isdir(path) else os.remove(path)
    ignore = shutil.ignore_patterns(*SKIP_DIRS, "*.pyc")
    for name in PUBLISH:
        src, dst = os.path.join(ROOT, name), os.path.join(STAGE, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=ignore, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)
    # The public item data: SRD 5.1 only.
    run(sys.executable, os.path.join(ROOT, "tools", "build_srd.py"), "--srd-only", os.path.join(STAGE, "js", "srd-data.js"), cwd=ROOT)


def check_private():
    git("add", "-A")
    tracked = git("ls-files", capture=True).splitlines()
    leaked = [f for f in tracked if any(p in f.lower() for p in PRIVATE)]
    if leaked:
        git("reset", "-q")
        sys.exit(f"Refusing to publish private files: {leaked}")


def commit_and_push(message):
    check_private()
    if not git("status", "--porcelain", capture=True):
        print("Nothing changed since the last publish.")
    else:
        git("commit", "-q", "-m", message)
        print("Committed:", message.splitlines()[0])
    git("push", "-q", "-u", "origin", "HEAD:main")
    print(f"Pushed. Site: https://{REPO.split('/')[0]}.github.io/{REPO.split('/')[1]}/")


def next_version(tags):
    """The next minor version after the newest vX.Y.Z tag: v1.0.0 for the first."""
    vs = []
    for t in tags:
        parts = t[1:].split(".") if t.startswith("v") else []
        if len(parts) == 3 and all(x.isdigit() for x in parts) and int(parts[0]) < 1000:  # (not a date)
            vs.append(tuple(map(int, parts)))
    if not vs:
        return "v1.0.0"
    major, minor, _ = max(vs)
    return f"v{major}.{minor + 1}.0"


def release(title_extra=None, notes_file=None, version=None):
    # Sign with the same key as local builds so phones can update in place.
    shutil.copytree(os.path.join(ROOT, "android", "keystore"), os.path.join(STAGE, "android", "keystore"), dirs_exist_ok=True)
    run(sys.executable, os.path.join(STAGE, "tools", "build_exe.py"))
    run(sys.executable, os.path.join(STAGE, "tools", "build_apk.py"))
    tags = set(git("tag", "--list", capture=True).splitlines()) | set(
        run("gh", "release", "list", "--repo", REPO, "--json", "tagName", "--jq", ".[].tagName", capture=True).splitlines())
    tag = ("v" + version.lstrip("v")) if version else next_version(tags)
    if tag in tags:
        sys.exit(f"{tag} is already released")
    notes = ("**Downloads:** `IsThisAMimic.exe` for Windows 10/11, `IsThisAMimic.apk` for Android 7.0+, "
             f"or use it in the browser at https://{REPO.split('/')[0]}.github.io/{REPO.split('/')[1]}/app/\n\n"
             "Windows may show a SmartScreen warning because the app isn't code-signed: choose *More info → Run anyway*.")
    if notes_file:
        with open(notes_file, encoding="utf8") as f:
            notes = f.read().strip() + "\n\n---\n\n" + notes
    title = f"Is This A Mimic? {tag}" + (f" — {title_extra}" if title_extra else "")
    run("gh", "release", "create", tag, "--repo", REPO, "--target", "main", "--title", title, "--notes", notes,
        os.path.join(STAGE, "dist", "IsThisAMimic.exe"), os.path.join(STAGE, "dist", "IsThisAMimic.apk"))
    print(f"Released {tag}: https://github.com/{REPO}/releases/tag/{tag}")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # (messages may have − or …; Windows' console is cp1252)
    args = sys.argv[1:]
    message = args[args.index("-m") + 1] if "-m" in args else f"Update Is This A Mimic? ({datetime.date.today():%Y-%m-%d})"
    stage()
    commit_and_push(message)
    opt = lambda name: args[args.index(name) + 1] if name in args else None
    if "--release" in args:
        release(opt("--title"), opt("--notes"), opt("--version"))


if __name__ == "__main__":
    main()
