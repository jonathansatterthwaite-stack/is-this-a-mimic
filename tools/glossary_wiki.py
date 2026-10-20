"""The wiki's Glossary page from docs/glossary.md (the project's own, which has code names in it):
the same terms and labelled pictures, for players: no code names (the Where column's `…` and the
Code column), no internal names, the pictures copied into the wiki's images/glossary/.

    python tools/glossary_wiki.py   (then commit the wiki)
"""
import os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "glossary.md")
WIKI = os.path.join(os.path.dirname(ROOT), "is-this-a-mimic.wiki")
IMAGES = os.path.join(ROOT, "docs", "glossary-images")

def cells(row):
    return [c.strip() for c in row.strip().strip("|").split("|")]

def main():
    text = open(SRC, encoding="utf8").read().replace("\r\n", "\n")
    out, drop_col = [], None
    for line in text.split("\n"):
        if line.startswith("The pictures are labelled") or line.startswith("`packrat-shots/glossary-shots.mjs`"):
            continue  # (how they're made: the project's business)
        if "Clockwork" in line:
            continue  # (an internal name: never in what players read)
        line = line.replace("(the user also says *On hand*)", "(also called *On hand*)").replace("glossary-images/", "images/glossary/")
        # (code names anywhere else: camelCase names, and where things are kept)
        line = re.sub(r"\s*\(`campaign\.[\w.]+`\)|\s*`[a-z]+[A-Z]\w*(?:\(\))?`", "", line)
        line = re.sub(r",?\s*`ui\.\w+`", "", line).replace(" ,", "").rstrip(" ,")
        line = line.replace("so a request can point at exactly one thing.", "so you can name exactly the part you mean.")
        line = line.replace('The old names still lead there (`go("catalog")`, `#shops`).', "Old links to the Catalog or Shops tabs still lead there.")
        if line.startswith("Each entry says what it is and where to find it."):
            line = "Each entry says what it is and where to find it. **Bold** is the name on screen."
        elif line.startswith("reference (where it lives in the code)"):
            continue
        if line.startswith("|"):
            c = cells(line)
            if c and c[0] == "Term":  # a table's header: which column holds code names
                drop_col = c.index("Code") if "Code" in c else None
            if drop_col is not None and len(c) > drop_col:
                c = c[:drop_col] + c[drop_col + 1:]
            elif c and c[0] != "Term" and not set(line) <= set("|-: "):
                # the Where cell (the third, whatever the header says), without its code names
                for i in range(2, len(c)):
                    w = re.sub(r"`[^`]*`(?:\s*\([^)]*\))?", "", c[i])
                    w = re.sub(r"\s*,\s*(,|$)", r"\1", w).strip(" ,;.")
                    c[i] = (w + ".") if w and not w.endswith((".", "!", "?", ")")) else w
            if set(line) <= set("|-: "):
                n = len(cells(line)) - (1 if drop_col is not None else 0)
                line = "|" + "|".join(["---"] * n) + "|"
            else:
                line = "| " + " | ".join(c) + " |"
        out.append(line)
    page = "\n".join(out).replace("# Glossary\n", "", 1).lstrip("\n")
    page = re.sub(r"\n{3,}", "\n\n", page)
    open(os.path.join(WIKI, "Glossary.md"), "w", encoding="utf8", newline="\n").write(page)
    dest = os.path.join(WIKI, "images", "glossary")
    os.makedirs(dest, exist_ok=True)
    for f in os.listdir(IMAGES):
        if f.endswith(".png"):
            shutil.copy2(os.path.join(IMAGES, f), os.path.join(dest, f))
    leftover = re.findall(r"`[#.][\w-]+`|Clockwork", page)
    print(f"Wrote Glossary.md ({len(page)} chars), {len(os.listdir(dest))} pictures" + (f"; check: {leftover[:5]}" if leftover else ""))

if __name__ == "__main__":
    sys.exit(main())
