# Is This A Mimic(s)? (ITAM(s)?)

**An inventory manager for tabletop RPGs.** Every character's gear, coins and containers, on PC, phone or in the browser: on your own, or shared at the table over your own Wi-Fi, with no account and no internet needed.

**[Windows app](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/releases/latest/download/ITAMSapp.exe)** · **[Android app](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/releases/latest/download/ITAMSapp.apk)** · **[Use it in your browser](https://jonathansatterthwaite-stack.github.io/is-this-a-mimic/app/)** · [User guide](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki) · [All releases](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/releases)

*Is This A Mimic(s)? is the new name of Pack Rat, as a fresh start: install it anew. It replaces Pack Rat (its data isn't kept, and Pack Rat's files can't be opened).*

![Is This A Mimic(s)?: an inventory in tiles](https://raw.githubusercontent.com/wiki/jonathansatterthwaite-stack/is-this-a-mimic/images/inventory-tiles.png)

## What it does

- **Containers that make sense.** Backpacks inside chests, gear strapped to the outside, quivers that only take arrows, waterskins that know how full they are, and a gauge on every container as it fills. ([Containers](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Containers))
- **Play together at the table.** Host a party from the Windows or Android app; everyone else joins by scanning a QR code. Each player keeps their own inventory, and trades, shops and the GM's changes reach everyone live. ([Party play](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Party-Play))
- **Tools for the GM.** Shops that buy and sell, treasure hoards and roll tables, control panels of sliders, switches and maps, and item states with rules (a blade that curses whoever attunes to it). ([Running the game](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Running-the-Game))
- **Live, hand-drawn icons.** Draw an item's icon from shapes and make it move: a waterskin's level, a clock showing the real time, a compass turning towards a ship on the GM's sea chart. ([Drawn icons](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Drawn-Icons))
- **D&D 5e built in, any game you like.** The SRD 5.1 catalog, Armor Class, encumbrance, attunement and attacks come with it; other game systems are files to import, or write your own. ([Writing a game system](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Writing-a-Game-System))
- **Your own items.** Custom items and templates, built from features (container, liquid, charges, writing…) and shared between campaigns in rule packages. ([Custom items](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Catalog-and-Custom-Items))
- **Cards, letters and maps.** Decks to draw from, books and letters to write in, maps and handouts to zoom around. ([Sets](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Sets-and-Drawing-Cards) · [Writing and pictures](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Writing-and-Pictures))
- **Quick to use.** Press and hold any item for a menu of what you can do with it, search with keys like `t:armor` or `c:backpack`, and show lists as rows or tiles with exactly the details you want. ([Your inventory](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Your-Inventory))
- **Yours, offline.** Several campaigns, each with its own characters; everything saved on your device, works offline, and exports to a file whenever you like. ([Settings and backups](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Settings-and-Backups))

<img src="https://raw.githubusercontent.com/wiki/jonathansatterthwaite-stack/is-this-a-mimic/images/item-menu.png" alt="Press and hold an item: the item menu" width="49%"> <img src="https://raw.githubusercontent.com/wiki/jonathansatterthwaite-stack/is-this-a-mimic/images/gm-panel.png" alt="A GM's control panel" width="49%">

## Get started

Download the app for Windows or Android, or open it in your browser, and the [Getting Started](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Getting-Started) page takes it from there. The [user guide](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki) explains everything, with pictures; the app links to it from Settings.

## For developers

Is This A Mimic(s)? is plain HTML, CSS and JavaScript with no build step; the party server is Python (standard library only), with a Java port in the Android app. Running it from source, building the apps, updating the item data and a map of the files: [Developing](https://github.com/jonathansatterthwaite-stack/is-this-a-mimic/wiki/Developing).

## Credits

This work includes material from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC, available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/legalcode). Item tables were parsed from dnd5e.wikidot.com (CC BY-SA 3.0). The icon editor is [svg-lay-tool](https://github.com/jonathansatterthwaite-stack/Svg-lay-tool) (MIT). Item icons are from [game-icons.net](https://game-icons.net) by Lorc, Delapouite, Carl Olsen, DarkZaitzev, Faithtoken, John Redman, Lucas, Sbed, Skoll, Willdabeast and Zajkonur, under CC BY 3.0. The icon editor's text uses the fonts Alegreya, Nunito and Caveat, under the SIL Open Font License 1.1 (js/vendor/OFL-*.txt). This is an unofficial fan tool, not affiliated with or endorsed by Wizards of the Coast.
