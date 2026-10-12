<h1 align="center">Anki JP Highlight</h1>

<div align="center">

Colors every Japanese word on any web page with the status color of its card in Anki.

[![license][license-image]][license-url]
[![release][release-image]][release-url]
[![install][install-image]][install-url]

[license-image]: https://img.shields.io/github/license/<usuario>/anki-jp-highlight?color=red
[license-url]: https://github.com/<usuario>/anki-jp-highlight/blob/main/LICENSE
[release-image]: https://img.shields.io/github/v/release/<usuario>/anki-jp-highlight?color=blue
[release-url]: https://github.com/<usuario>/anki-jp-highlight/releases/latest
[install-image]: https://img.shields.io/badge/install-Tampermonkey%20%7C%20Violentmonkey-4caf7d?style=flat-square&logo=tampermonkey
[install-url]: https://raw.githubusercontent.com/<usuario>/anki-jp-highlight/main/anki-jp-highlight.user.js

</div>

## What it does

Every Japanese word gets the status color of its card — `new`, `learning`, `review`, `suspended`,
`buried` — with an underline, like the jiten reader. Words without a card stay plain text. Works on
any page (`*://*/*`): news, mokuro, subtitles, articles.

Word boundaries come from a morphological analyzer, so `食べました` highlights `食べる` and
`食べに行く` highlights `食べ` and `行く`. A kana→kanji index built from the readings of your own
cards is what lets `こない` highlight as `来る`.

## Install

### Requirements

- **Anki desktop** running, with the [AnkiConnect](https://ankiweb.net/shared/info/2055492159)
  add-on listening on `127.0.0.1:8765`.
- A userscript manager — [Tampermonkey](https://www.tampermonkey.net/) or
  [Violentmonkey](https://violentmonkey.github.io/).

### Installing

With the manager installed, open the URL below (or paste the content into _Create a new script_):

```text
https://raw.githubusercontent.com/<usuario>/anki-jp-highlight/main/anki-jp-highlight.user.js
```

The manager updates itself on every `@version` bump.

If AnkiConnect rejects the page origin, add that origin to `webCorsOriginList` in its config. The
script declares `@connect 127.0.0.1` (AnkiConnect) and `@connect cdn.jsdelivr.net` (the `.wasm`
dictionary of `@libraz/suzume`, version pinned in `SUZUME_VERSION`).

## Usage

- **Status colors** in `STATUS_COLORS`. The same word in more than one deck resolves by
  `STATUS_PRIORITY` (`review` > `learning` > `new` > `suspended` > `buried`).
- **Manager menu**: _Recarregar status do Anki_ clears the daily cache and queries again (use it
  after reviewing), and _Reconstruir indice kana->kanji_ rebuilds the reading index.
- **Cost**: each word's status is cached for the day (`CACHE_KEY`, `GM_setValue`) — a second visit
  to the same word makes no request. The reading index is built once a day, `INDEX_BUILD_DELAY_MS`
  after load, in chunks of `INDEX_CHUNK` notes.
- **Tuning** is done with the constants at the top of the file: `FIELDS`, `READING_FIELDS`,
  `STATUS_COLORS`, `DECK_FILTER`, `ANKI_URL`.

## Development

```sh
bun install     # dev deps + hooks
bun run lint    # eslint (validates the ==UserScript== block)
bun run format  # prettier
bun run secrets # secretlint
```

To test: _Create a new script_ in the manager and paste the content, or install from the URL above —
the extension only applies changes after you reload the tab.

## Credits

- Morphological analysis: [`@libraz/suzume`](https://github.com/libraz/suzume) (Apache-2.0),
  vendored at the end of the file as a minified bundle.
- `.wasm` dictionary served by [jsDelivr](https://www.jsdelivr.com/), pinned version.

## License

MIT — see [`LICENSE`](./LICENSE). The vendored `suzume` remains under Apache-2.0 (copy in
[`THIRD-PARTY-NOTICES.txt`](./THIRD-PARTY-NOTICES.txt)).
