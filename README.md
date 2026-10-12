<h1 align="center">Anki JP Highlight</h1>

<div align="center">

Pinta as palavras japonesas de qualquer página com a cor do status do card no Anki.

[![release][release-image]][release-url]
[![GreasyFork][greasyfork-image]][greasyfork-url]

[release-image]: https://img.shields.io/github/v/release/<usuario>/anki-jp-highlight?color=blue
[release-url]: https://github.com/<usuario>/anki-jp-highlight/releases/latest
[greasyfork-image]: https://img.shields.io/badge/Instalar%20no-Greasy%20Fork-960000
[greasyfork-url]: https://greasyfork.org/scripts/<id>-anki-jp-highlight

</div>

## O que faz

Cada palavra japonesa ganha a cor do status do card correspondente na sua coleção —
`new`, `learning`, `review`, `suspended`, `buried` — com underline, como no jiten reader. Palavra
sem card fica como texto puro. Funciona em qualquer página (`*://*/*`): notícia, mokuro, legenda,
artigo.

O corte das palavras é morfológico (`食べました` pinta `食べる`, `食べに行く` pinta `食べ` e `行く`), e
um índice kana→kanji montado das leituras dos próprios cards permite pintar `こない` como `来る`.

## Instalação

### Requisitos

- **Anki desktop** aberto, com o add-on [AnkiConnect](https://ankiweb.net/shared/info/2055492159)
  escutando em `127.0.0.1:8765`.
- Um gerenciador de userscripts — [Tampermonkey](https://www.tampermonkey.net/) ou
  [Violentmonkey](https://violentmonkey.github.io/).

### Instalar

1. Instale pelo [Greasy Fork][greasyfork-url], ou
2. instale direto deste repositório:

```text
https://raw.githubusercontent.com/<usuario>/anki-jp-highlight/main/anki-jp-highlight.user.js
```

O gerenciador atualiza sozinho a cada bump de `@version`.

Se o AnkiConnect recusar a origem da página, adicione essa origin em `webCorsOriginList` na config
dele. O script declara `@connect 127.0.0.1` (AnkiConnect) e `@connect cdn.jsdelivr.net` (dicionário
`.wasm` do `@libraz/suzume`, versão pinada em `SUZUME_VERSION`).

## Uso

- **Cores por status** em `STATUS_COLORS`. Mesma palavra em decks diferentes resolve por
  `STATUS_PRIORITY` (`review` > `learning` > `new` > `suspended` > `buried`).
- **Menu do gerenciador**: _Recarregar status do Anki_ (limpa o cache do dia e re-consulta, depois
  de estudar) e _Reconstruir índice kana->kanji_.
- **Custo**: o status de cada palavra fica em cache diário (`CACHE_KEY`, `GM_setValue`) — segunda
  visita à mesma palavra não faz request. O índice de leituras é construído uma vez por dia,
  `INDEX_BUILD_DELAY_MS` após o load, em blocos de `INDEX_CHUNK` notas.
- **Ajustes** são constantes no topo do arquivo: `FIELDS`, `READING_FIELDS`, `STATUS_COLORS`,
  `DECK_FILTER`, `ANKI_URL`.

## Desenvolvimento

```sh
bun install     # dev deps + hooks
bun run lint    # eslint (valida o bloco ==UserScript==)
bun run format  # prettier
bun run secrets # secretlint
```

Para testar: "Criar novo script" na extensão e colar o conteúdo, ou instalar pela URL acima — a
extensão só aplica na página depois de recarregar a aba.

## Créditos

- Análise morfológica: [`@libraz/suzume`](https://github.com/libraz/suzume) (Apache-2.0), vendorado
  no fim do arquivo como bundle minificado.
- Dicionário `.wasm` servido pelo [jsDelivr](https://www.jsdelivr.com/), versão pinada.
