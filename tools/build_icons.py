"""Build js/icons-data.js: a curated set of item icons from game-icons.net.

    python tools/build_icons.py [--refresh]

Icons are by the game-icons.net contributors (https://game-icons.net), under
CC BY 3.0 (a few CC0); credits are written into the data file and shown in the
app. Each slot below lists candidate icon names; the first one that exists in
the game-icons repository is used. Downloads are cached in tools/.cache/icons.
"""
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", ".cache", "icons")
OUT = os.path.join(ROOT, "js", "icons-data.js")
TREE_URL = "https://api.github.com/repos/game-icons/icons/git/trees/master?recursive=1"
RAW = "https://raw.githubusercontent.com/game-icons/icons/master/"

AUTHORS = {
    "lorc": "Lorc", "delapouite": "Delapouite", "john-colburn": "John Colburn", "felbrigg": "Felbrigg",
    "john-redman": "John Redman", "carl-olsen": "Carl Olsen", "sbed": "Sbed", "priorblue": "PriorBlue",
    "willdabeast": "Willdabeast", "viscious-speed": "Viscious Speed", "lord-berandas": "Lord Berandas",
    "irongamer": "Irongamer", "heavenly-dog": "HeavenlyDog", "lucasms": "Lucas", "faithtoken": "Faithtoken",
    "skoll": "Skoll", "andymeneely": "Andy Meneely", "cathelineau": "Cathelineau", "kier-heyl": "Kier Heyl",
    "aussiesim": "Aussiesim", "sparker": "Sparker", "zeromancer": "Zeromancer", "rihlsul": "Rihlsul",
    "quoting": "Quoting", "guard13007": "Guard13007", "darkzaitzev": "DarkZaitzev", "spencerdub": "SpencerDub",
    "generalace135": "GeneralAce135", "zajkonur": "Zajkonur", "catsu": "Catsu", "starseeker": "Starseeker",
    "pepijn-poolman": "Pepijn Poolman", "pierre-leducq": "Pierre Leducq", "caro-asercion": "Caro Asercion",
}

# (id, label, search tags, candidate game-icons names)
ICONS = [
    # ---- weapons
    ("sword", "Sword", "longsword blade", ["broadsword", "sword-hilt", "stiletto"]),
    ("sword-curved", "Curved sword", "scimitar sabre", ["scimitar", "sabre", "curvy-knife"]),
    ("rapier", "Rapier", "fencing thin sword", ["rapier", "sword-brandish"]),
    ("greatsword", "Greatsword", "two-handed big sword", ["relic-blade", "sharp-crescent", "broadsword"]),
    ("shortsword", "Shortsword", "gladius short", ["gladius", "sword-hilt"]),
    ("dagger", "Dagger", "knife stiletto", ["plain-dagger", "stiletto", "curvy-knife"]),
    ("swords", "Crossed swords", "weapons combat", ["crossed-swords"]),
    ("axe", "Axe", "battleaxe", ["battle-axe", "war-axe", "sharp-axe"]),
    ("handaxe", "Hand axe", "hatchet throwing axe", ["hatchet", "wood-axe", "fire-axe"]),
    ("greataxe", "Greataxe", "big axe double", ["war-axe", "crossed-axes", "battered-axe"]),
    ("mace", "Mace", "morningstar club", ["mace-head", "spiked-mace", "flanged-mace"]),
    ("morningstar", "Morningstar", "spiked ball", ["spiked-mace", "morning-star", "mace-head"]),
    ("flail", "Flail", "chain ball", ["flail", "spiked-ball"]),
    ("hammer", "Warhammer", "maul war hammer", ["warhammer", "thor-hammer", "gavel"]),
    ("light-hammer", "Light hammer", "hammer tool", ["flat-hammer", "claw-hammer", "hammer-drop"]),
    ("war-pick", "War pick", "pick pickaxe mining", ["war-pick", "stone-axe"]),
    ("club", "Club", "greatclub cudgel", ["wood-club", "spiked-bat", "baseball-bat"]),
    ("staff", "Quarterstaff", "staff bo stick", ["bo", "wizard-staff", "orb-wand"]),
    ("spear", "Spear", "javelin pike", ["spear-hook", "stone-spear", "spear-head", "harpoon-trident"]),
    ("javelin", "Javelin", "throwing spear", ["spear-feather", "aerodynamic-harpoon", "thrown-spear"]),
    ("trident", "Trident", "fork sea", ["trident", "harpoon-trident"]),
    ("halberd", "Halberd", "polearm glaive pike", ["halberd", "glaive", "bardiche"]),
    ("glaive", "Glaive", "polearm blade", ["glaive", "naginata", "halberd"]),
    ("lance", "Lance", "joust mounted", ["lance", "barbed-spear", "spear-hook"]),
    ("sickle", "Sickle", "scythe farm", ["sickle", "scythe"]),
    ("scythe", "Scythe", "reaper", ["scythe"]),
    ("whip", "Whip", "lash", ["whip", "whiplash"]),
    ("bow", "Bow", "longbow shortbow archery", ["bow-arrow", "high-shot", "pocket-bow"]),
    ("crossbow", "Crossbow", "bolt", ["crossbow", "arbalest"]),
    ("sling", "Sling", "slingshot stone", ["slingshot", "sling"]),
    ("blowgun", "Blowgun", "dart tube", ["straight-pipe", "blowgun"]),
    ("dart", "Dart", "throwing", ["dart", "thrown-daggers"]),
    ("net", "Net", "fishing net trap", ["fishing-net", "spider-web"]),
    ("arrows", "Arrows", "ammunition quiver", ["arrow-cluster", "quiver", "arrows-shield"]),
    ("bolts", "Bolts", "crossbow ammunition", ["bolt-shield", "arrow-flights", "arrow-cluster"]),
    ("bullets", "Sling bullets", "stones ammunition pellets", ["stone-pile", "bullets", "shotgun-rounds"]),
    ("needles", "Needles", "blowgun ammunition", ["triple-needle", "needle-jaws", "sewing-needle"]),
    ("boomerang", "Boomerang", "throwing", ["boomerang"]),
    ("gun", "Firearm", "pistol musket", ["flintlock", "blunderbuss", "musket"]),
    ("bomb", "Bomb", "explosive grenade", ["unlit-bomb", "rolling-bomb", "powder"]),
    # ---- armor & clothes
    ("armor-leather", "Leather armor", "padded studded light", ["leather-armor", "leather-vest"]),
    ("armor-chain", "Chain mail", "chain shirt ring mail", ["chain-mail", "mail-shirt"]),
    ("armor-scale", "Scale mail", "scale lamellar", ["scale-mail", "lamellar"]),
    ("armor-breastplate", "Breastplate", "cuirass medium", ["breastplate", "abdominal-armor"]),
    ("armor-spiked", "Spiked armor", "spikes spiky", ["spiked-armor", "spiked-shoulder-armor"]),
    ("armor-plate", "Plate armor", "heavy full plate splint", ["plate-armor", "armor-vest", "breastplate"]),
    ("shield", "Shield", "kite heater", ["shield", "checked-shield", "slashed-shield"]),
    ("round-shield", "Round shield", "buckler", ["round-shield", "shield-reflect"]),
    ("helmet", "Helmet", "helm head", ["visored-helm", "closed-barbute", "barbute", "brutal-helm"]),
    ("gauntlets", "Gauntlets", "gloves hands", ["gauntlet", "mailed-fist", "gloves"]),
    ("boots", "Boots", "shoes feet", ["boots", "leather-boot", "walking-boot"]),
    ("cloak", "Cloak", "cape mantle", ["cape", "cloak", "hood"]),
    ("robe", "Robe", "vestments clothes", ["robe", "monk-robe"]),
    ("shirt", "Clothes", "shirt tunic common traveler", ["shirt", "t-shirt", "sleeveless-top"]),
    ("fine-clothes", "Fine clothes", "noble dress", ["dress", "tunic", "sleeveless-jacket"]),
    ("belt", "Belt", "girdle", ["belt", "belt-buckles"]),
    ("hat", "Hat", "cap", ["pointy-hat", "feathered-wing", "top-hat"]),
    ("mask", "Mask", "costume disguise", ["domino-mask", "carnival-mask", "duality-mask"]),
    # ---- containers & packs
    ("backpack", "Backpack", "pack bag", ["backpack", "knapsack"]),
    ("sack", "Sack", "bag pouch", ["swap-bag", "knapsack", "money-stack"]),
    ("pouch", "Pouch", "purse coin bag", ["coins-pile", "swap-bag", "sack"]),
    ("chest", "Chest", "trunk box", ["locked-chest", "chest", "open-treasure-chest"]),
    ("treasure-chest", "Treasure chest", "loot", ["open-treasure-chest", "open-chest"]),
    ("barrel", "Barrel", "keg cask", ["barrel", "beer-barrel"]),
    ("basket", "Basket", "wicker", ["basket", "wicker-basket", "picnic-basket"]),
    ("bucket", "Bucket", "pail water", ["empty-wood-bucket-handle", "empty-wood-bucket", "empty-metal-bucket"]),
    ("jug", "Jug", "pitcher ewer", ["jug", "amphora", "vase"]),
    ("flask", "Flask", "tankard bottle", ["square-bottle", "hip-flask", "round-bottom-flask"]),
    ("waterskin", "Waterskin", "canteen water", ["water-flask", "canteen", "water-bottle"]),
    ("bottle", "Bottle", "glass wine", ["wine-bottle", "square-bottle", "bottle-vapors"]),
    ("vial", "Vial", "test tube phial", ["corked-tube", "test-tubes", "vial"]),
    ("case", "Case", "scroll case map tube", ["scroll-quill", "corked-tube", "rolled-cloth"]),
    ("quiver", "Quiver", "arrow holder", ["quiver", "arrow-cluster"]),
    ("pot", "Pot", "iron pot cauldron cooking", ["cooking-pot", "cauldron"]),
    # ---- adventuring gear
    ("rope", "Rope", "hemp silk coil", ["rope-coil", "lasso", "rope-bridge"]),
    ("chain", "Chain", "links", ["chain", "crossed-chains", "linked-rings"]),
    ("torch", "Torch", "fire light", ["torch", "fire"]),
    ("candle", "Candle", "light wax", ["candle-light", "candle-flame", "candles"]),
    ("lantern", "Lantern", "hooded bullseye light", ["lantern-flame", "lantern", "oil-lamp"]),
    ("lamp", "Lamp", "oil light", ["oil-lamp", "magic-lamp", "lantern-flame"]),
    ("tinderbox", "Tinderbox", "flint fire starter matches", ["matchbox", "match-tip", "fire-silhouette"]),
    ("bedroll", "Bedroll", "blanket sleeping", ["sleeping-bag", "bed", "rolled-cloth"]),
    ("tent", "Tent", "camp", ["camping-tent", "tent"]),
    ("mess-kit", "Mess kit", "cutlery utensils", ["knife-fork", "tin-can", "cooking-pot"]),
    ("rations", "Rations", "food meal jerky", ["meal", "meat", "sliced-bread"]),
    ("bread", "Bread", "food loaf", ["bread", "sliced-bread", "bread-slice"]),
    ("meat", "Meat", "food drumstick", ["meat", "ham-shank", "chicken-leg"]),
    ("cheese", "Cheese", "food", ["cheese-wedge", "cheese"]),
    ("apple", "Fruit", "apple food", ["shiny-apple", "apple-maggot", "cherry"]),
    ("drink", "Drink", "ale beer mug tankard", ["beer-stein", "wine-glass", "goblet"]),
    ("wine", "Wine", "bottle drink", ["brandy-bottle", "wine-glass", "wine-bottle"]),
    ("crowbar", "Crowbar", "pry bar", ["crowbar", "claw-hammer"]),
    ("shovel", "Shovel", "spade dig", ["shovel", "spade"]),
    ("pickaxe", "Pick", "miner's pick mining", ["mining", "war-pick", "stone-axe"]),
    ("sledgehammer", "Sledgehammer", "maul", ["hammer-drop", "3d-hammer", "warhammer"]),
    ("hammer-tool", "Hammer", "tool nails", ["hammer-nails", "claw-hammer", "flat-hammer"]),
    ("piton", "Piton", "spike climbing", ["spikes", "nails", "spiked-fence"]),
    ("grappling-hook", "Grappling hook", "climbing hook", ["grappling-hook", "hook"]),
    ("ladder", "Ladder", "climb", ["ladder"]),
    ("pole", "Pole", "10-foot pole stick", ["wood-stick", "water-diviner-stick", "bo"]),
    ("ram", "Ram", "battering door", ["battering-ram", "ram"]),
    ("lock", "Lock", "padlock", ["padlock", "locked-fortress", "unlocking"]),
    ("key", "Key", "door skeleton", ["key", "skeleton-key", "door-key"]),
    ("lockpicks", "Thieves' tools", "lockpick picks", ["lockpicks", "key-lock", "skeleton-key"]),
    ("manacles", "Manacles", "shackles chains", ["manacles", "shackles", "handcuffs"]),
    ("caltrops", "Caltrops", "spikes trap", ["caltrops", "spikes"]),
    ("trap", "Trap", "hunting bear trap", ["wolf-trap", "bear-trap", "man-trap"]),
    ("ball-bearings", "Ball bearings", "marbles balls", ["marbles", "billiard", "globe"]),
    ("fishing", "Fishing tackle", "rod pole line", ["fishing-pole", "fishing-hook", "fishing-lure"]),
    ("spyglass", "Spyglass", "telescope", ["spyglass", "telescope"]),
    ("magnifier", "Magnifying glass", "lens", ["magnifying-glass", "lens"]),
    ("compass", "Compass", "navigation", ["compass", "sextant"]),
    ("hourglass", "Hourglass", "time sand", ["hourglass", "sands-of-time"]),
    ("bell", "Bell", "ring", ["ringing-bell", "bell"]),
    ("whistle", "Whistle", "signal", ["whistle", "sound-waves"]),
    ("mirror", "Mirror", "steel mirror", ["hand-mirror", "mirror-mirror"]),
    ("soap", "Soap", "wash clean", ["soap", "bubbles"]),
    ("perfume", "Perfume", "scent", ["perfume-bottle", "fragrance"]),
    ("needle", "Sewing kit", "needle thread", ["sewing-needle", "sewing-string", "yarn"]),
    ("abacus", "Abacus", "counting", ["abacus", "calculator"]),
    ("scales", "Scales", "merchant balance", ["scales", "weight"]),
    ("healer-kit", "Healer's kit", "medicine bandage first aid", ["first-aid-kit", "medical-pack", "bandage-roll"]),
    ("bandage", "Bandage", "heal wound", ["bandage-roll", "bandaged"]),
    ("herbs", "Herbs", "herbalism plants", ["herbs-bundle", "leaf", "vine-flower"]),
    ("mushroom", "Mushroom", "fungus", ["mushroom", "mushrooms"]),
    ("acid", "Acid", "corrosive vial", ["acid", "bubbling-flask"]),
    ("alchemist-fire", "Alchemist's fire", "flask flame", ["fire-bottle", "molotov", "flaming-arrow"]),
    ("holy-water", "Holy water", "blessed flask", ["holy-water", "sprinkler", "water-drop"]),
    ("oil", "Oil", "flask lamp oil", ["oil-drum", "drop", "flask"]),
    ("chalk", "Chalk", "marking", ["chalk-outline-murder", "pencil", "crayon"]),
    ("ink", "Ink & quill", "pen writing", ["quill-ink", "quill", "feather"]),
    ("paper", "Paper", "parchment sheet letter", ["paper", "folded-paper", "scroll-unfurled"]),
    ("book", "Book", "tome lore", ["book-cover", "open-book", "closed-book"]),
    ("spellbook", "Spellbook", "magic tome", ["spell-book", "book-aura", "secret-book"]),
    ("scroll", "Scroll", "spell scroll", ["scroll-unfurled", "tied-scroll", "scroll-quill"]),
    ("map", "Map", "treasure chart", ["treasure-map", "folded-paper", "scroll-unfurled"]),
    ("letter", "Letter", "sealed message", ["envelope", "wax-seal", "love-letter"]),
    ("seal", "Sealing wax", "signet stamp", ["wax-seal", "stamper"]),
    # ---- tools & instruments
    ("toolbox", "Tools", "toolbox kit", ["toolbox", "spanner", "hammer-nails"]),
    ("anvil", "Smith's tools", "anvil forge blacksmith", ["anvil-impact", "anvil"]),
    ("saw", "Carpenter's tools", "saw wood", ["hand-saw", "saw-claw", "wood-beam"]),
    ("brush", "Painter's supplies", "paint brush", ["paint-brush", "paint-bucket", "palette"]),
    ("pottery", "Potter's tools", "vase clay", ["amphora", "vase", "clay-brick"]),
    ("gear-cog", "Tinker's tools", "gears clockwork", ["gears", "cog", "gear-hammer"]),
    ("chisel", "Mason's tools", "stone chisel", ["stone-block", "brick-wall", "stone-crafting"]),
    ("gem-tools", "Jeweler's tools", "gem cutting", ["gem-pendant", "cut-diamond", "diamond-hard"]),
    ("loom", "Weaver's tools", "yarn thread cloth", ["yarn", "sewing-string", "rolled-cloth"]),
    ("knife-carve", "Woodcarver's tools", "knife wood carving", ["wood-pile", "whittle", "carving"]),
    ("boot-tool", "Cobbler's tools", "shoe boot", ["boot-stomp", "leather-boot", "boots"]),
    ("leatherwork", "Leatherworker's tools", "hide tanning", ["animal-hide", "leather-vest", "leather-armor"]),
    ("glassblow", "Glassblower's tools", "glass", ["glass-ball", "crystal-ball", "bubbling-flask"]),
    ("cook", "Cook's utensils", "cooking kitchen", ["camp-cooking-pot", "knife-fork", "cooking-pot"]),
    ("brewer", "Brewer's supplies", "beer ale brewing", ["beer-bottle", "beer-barrel", "beer-stein"]),
    ("calligraphy", "Calligrapher's supplies", "writing ink quill", ["scroll-quill", "quill", "quill-ink"]),
    ("cartography", "Cartographer's tools", "maps drafting", ["folded-paper", "treasure-map", "compass"]),
    ("navigator", "Navigator's tools", "sextant sea", ["sextant", "compass", "ship-wheel"]),
    ("alchemy", "Alchemist's supplies", "alchemy flask lab", ["fizzing-flask", "round-bottom-flask", "bubbling-flask"]),
    ("disguise", "Disguise kit", "mask costume", ["duality-mask", "domino-mask", "carnival-mask"]),
    ("forgery", "Forgery kit", "fake documents", ["stamper", "quill", "scroll-quill"]),
    ("poisoner", "Poisoner's kit", "poison tools", ["poison-gas", "poison-cloud", "potion-of-madness"]),
    ("dice", "Dice set", "gaming dice", ["rolling-dices", "dice-six-faces-five", "perspective-dice-six"]),
    ("cards", "Playing cards", "card deck gaming", ["card-random", "poker-hand", "card-play"]),
    ("chess", "Dragonchess set", "chess board game", ["chess-knight", "chess-king", "chess-rook"]),
    ("lute", "Lute", "instrument music", ["lute", "guitar"]),
    ("flute", "Flute", "shawm pipe instrument", ["flute", "pan-flute"]),
    ("pan-flute", "Pan flute", "pipes instrument", ["pan-flute", "flute"]),
    ("drum", "Drum", "percussion instrument", ["drum", "drum-kit"]),
    ("harp", "Lyre / Harp", "instrument strings", ["harp", "lyre"]),
    ("horn", "Horn", "instrument hunting", ["hunting-horn", "horn-call", "trumpet"]),
    ("bagpipes", "Bagpipes", "instrument", ["bagpipes"]),
    ("violin", "Viol", "violin fiddle instrument", ["violin", "cello"]),
    ("dulcimer", "Dulcimer", "zither instrument", ["piano-keys", "harp", "musical-notes"]),
    ("music", "Instrument", "music notes", ["musical-notes", "music-spell"]),
    # ---- magic & consumables
    ("potion", "Potion", "healing drink", ["potion-ball", "round-bottom-flask", "drink-me"]),
    ("potion-red", "Healing potion", "health red", ["heart-bottle", "health-potion", "potion-ball"]),
    ("poison", "Poison", "toxin venom", ["poison-bottle", "potion-of-madness", "skull-crossed-bones"]),
    ("venom", "Venom", "snake fang", ["snake-bite", "fangs", "snake"]),
    ("antitoxin", "Antitoxin", "cure antidote", ["medicine-pills", "pill", "vial"]),
    ("wand", "Wand", "magic stick", ["fairy-wand", "orb-wand", "lightning-trio"]),
    ("rod", "Rod", "scepter", ["scepter", "royal-staff", "crystal-wand"]),
    ("magic-staff", "Staff", "wizard magic", ["wizard-staff", "orb-wand", "bo"]),
    ("orb", "Orb", "crystal ball arcane focus", ["crystal-ball", "orb-direction", "glass-ball"]),
    ("crystal", "Crystal", "arcane focus gem", ["crystal-growth", "crystal-bars", "crystal-cluster"]),
    ("holy-symbol", "Holy symbol", "amulet emblem religion", ["holy-symbol", "ankh", "egyptian-cross"]),
    ("reliquary", "Reliquary", "relic holy", ["crystal-shrine", "prayer", "church"]),
    ("totem", "Totem", "druid focus", ["totem-head", "totem-mask", "totem"]),
    ("mistletoe", "Sprig of mistletoe", "druid plant", ["holly-berry", "sprout", "leaf"]),
    ("ring", "Ring", "signet magic", ["ring", "diamond-ring", "gem-chain"]),
    ("amulet", "Amulet", "necklace pendant", ["tribal-pendant", "pendant-key", "gem-pendant"]),
    ("crown", "Crown", "royal tiara", ["crown", "queen-crown", "crowned-heart"]),
    ("cape-magic", "Magic cloak", "cloak of", ["wing-cloak", "vampire-cape", "cape"]),
    ("sparkles", "Magic item", "sparkles wondrous", ["sparkles", "magic-swirl", "star-swirl"]),
    ("rune", "Rune", "runestone magic", ["rune-stone", "runic", "stone-tablet"]),
    ("incense", "Incense", "censer smoke", ["incense", "smoking-orb", "fire-bowl"]),
    ("alms-box", "Alms box", "donation", ["donation", "piggy-bank", "chest"]),
    # ---- treasure
    ("coins", "Coins", "gold money", ["two-coins", "coins", "crown-coin"]),
    ("gem", "Gem", "gemstone jewel diamond", ["cut-diamond", "emerald", "gems"]),
    ("gold-bar", "Gold bar", "ingot trade good", ["gold-bar", "metal-bar", "ingot"]),
    ("gem-emerald", "Green gem", "emerald jade peridot gemstone", ["emerald", "gems"]),
    ("gem-fire", "Red gem", "ruby garnet fire opal gemstone", ["fire-gem", "gems"]),
    ("gems", "Gemstones", "stones agate opal jewels", ["gems", "crystal-cluster"]),
    ("pearl", "Pearl", "oyster black pearl", ["oyster-pearl", "pearl-necklace"]),
    ("metal-bar", "Metal bar", "iron copper silver ingot trade good", ["metal-bar", "gold-bar"]),
    # ---- trade goods & livestock
    ("wheat", "Wheat", "grain crop trade good", ["wheat", "grain-bundle", "grain"]),
    ("flour", "Flour", "sack grain baking", ["flour", "powder-bag"]),
    ("salt", "Salt", "seasoning trade good", ["salt-shaker", "powder"]),
    ("spices", "Spices", "pepper cinnamon saffron ginger cloves", ["hot-spices", "cool-spices"]),
    ("cloth", "Cloth", "canvas cotton linen silk fabric bolt", ["rolled-cloth", "clothesline"]),
    ("chicken", "Chicken", "hen rooster poultry livestock", ["chicken", "rooster"]),
    ("goat", "Goat", "livestock", ["goat"]),
    ("sheep", "Sheep", "lamb wool livestock", ["sheep"]),
    ("pig", "Pig", "hog swine livestock", ["pig", "boar"]),
    ("cow", "Cow", "cattle livestock", ["cow"]),
    ("ox", "Ox", "bull oxen livestock draft", ["bull", "cow"]),
    ("art", "Art object", "statue figurine", ["statue", "painted-pottery", "venus-of-willendorf"]),
    ("goblet", "Goblet", "chalice cup", ["goblet", "chalice-drops", "wine-glass"]),
    # ---- trinkets & oddities
    ("trinket", "Trinket", "curio odd thing", ["snow-bottle", "bottled-shadow", "matryoshka-dolls"]),
    ("skull", "Skull", "bones death", ["skull-crossed-bones", "skull", "dead-head"]),
    ("bone", "Bone", "skeleton", ["broken-bone", "bone-gnawer", "bones"]),
    ("tooth", "Tooth", "fang", ["tooth", "fangs"]),
    ("feather", "Feather", "quill bird", ["feather", "quill"]),
    ("eye", "Eye", "glass eye", ["eyeball", "evil-eye", "eye-target"]),
    ("hand", "Hand", "mummified", ["mummy-head", "hand", "severed-hand"]),
    ("doll", "Doll", "figurine toy", ["rag-doll", "voodoo-doll", "matryoshka-dolls"]),
    ("figurine", "Figurine", "statuette carving", ["statue", "pawn", "chess-pawn"]),
    ("shell", "Shell", "seashell", ["spiral-shell", "sea-star", "clam"]),
    ("stone", "Stone", "rock pebble", ["stone-sphere", "rock", "stone-pile"]),
    ("clock", "Pocket watch", "clock time", ["pocket-watch", "stopwatch", "sundial"]),
    ("music-box", "Music box", "tune", ["music-spell", "musical-notes", "gift-of-knowledge"]),
    ("flower", "Flower", "dried plant", ["flower-pot", "lotus-flower", "rose"]),
    ("candy", "Sweet", "candy treat", ["wrapped-sweet", "candy-canes", "cupcake"]),
    ("heart", "Heart", "love locket", ["hearts", "glass-heart", "heart-necklace"]),
    ("egg", "Egg", "dragon egg", ["dragon-egg", "egg-clutch", "shiny-egg"]),
    ("puzzle", "Puzzle", "cube box", ["puzzle", "cubeforce", "rubik-cube"]),
    ("paw", "Paw", "animal claw", ["paw-print", "claw-slashes", "bear-face"]),
    ("tentacle", "Tentacle", "weird eldritch", ["tentacle-strike", "tentacles-skull", "octopus"]),
    ("question", "Unknown", "mystery unidentified", ["uncertainty", "perspective-dice-six-faces-random", "help"]),
]


def fetch(url, path, refresh):
    if refresh or not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "mimic-build"})
        with urllib.request.urlopen(req) as r, open(path, "wb") as f:
            f.write(r.read())
    with open(path, encoding="utf8") as f:
        return f.read()


def shape(svg):
    """The white foreground path(s) of a game-icons SVG (the black square is the background)."""
    if "transform" in svg:
        return None
    ds = [m.group(2) for m in re.finditer(r'<path([^>]*?)\sd="([^"]+)"', svg) if 'fill="#fff"' in m.group(1)]
    if not ds:
        ds = [m.group(2) for m in re.finditer(r'<path([^>]*?)\sd="([^"]+)"', svg)
              if m.group(2).strip().upper() not in ("M0 0H512V512H0Z",)]
    return " ".join(ds) or None


def main():
    refresh = "--refresh" in sys.argv
    tree = json.loads(fetch(TREE_URL, os.path.join(CACHE, "tree.json"), refresh))
    by_name = {}
    for e in tree["tree"]:
        p = e["path"]
        # "badges/" holds UI badge templates rather than an artist's icons.
        if p.endswith(".svg") and "/" in p and not p.startswith("badges/"):
            by_name.setdefault(os.path.basename(p)[:-4], p)
    out, missing, used_authors, used = [], [], set(), set()
    for icon_id, label, tags, candidates in ICONS:
        # Each slot should look different: try pictures no other slot has taken first.
        ordered = [c for c in candidates if c not in used] + [c for c in candidates if c in used]
        for name in ordered:
            path = by_name.get(name)
            if not path:
                continue
            d = shape(fetch(RAW + path, os.path.join(CACHE, path), refresh))
            if not d:
                continue
            author = path.split("/")[0]
            used_authors.add(author)
            used.add(name)
            out.append({"id": icon_id, "n": label, "t": tags, "d": d, "a": author, "src": name})
            break
        else:
            missing.append((icon_id, candidates))
    credits = sorted({AUTHORS.get(a, a.replace("-", " ").title()) for a in used_authors})
    with open(OUT, "w", encoding="utf8") as f:
        f.write("// Generated by tools/build_icons.py - do not edit by hand.\n")
        f.write("// Icons from game-icons.net by " + ", ".join(credits) + ", under CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/).\n")
        f.write("const ICON_LIBRARY = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
        f.write("const ICON_CREDITS = " + json.dumps(credits) + ";\n")
    size = os.path.getsize(OUT)
    print(f"{len(out)} icons, {size / 1024:.0f} KB -> {OUT}")
    print("artists:", ", ".join(credits))
    if missing:
        print("MISSING (no candidate found):", ", ".join(i for i, _ in missing))


if __name__ == "__main__":
    main()
