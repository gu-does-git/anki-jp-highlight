// ==UserScript==
// @name          Anki JP Highlight
// @namespace     Violentmonkey Scripts
// @version       0.3.6
// @description   Colors Japanese words by the status of their card in Anki.
// @author        gu-does-git
// @license       MIT
// @match         *://*/*
// @grant         GM_xmlhttpRequest
// @grant         GM_registerMenuCommand
// @grant         GM_getValue
// @grant         GM_setValue
// @connect       127.0.0.1
// @connect       cdn.jsdelivr.net
// ==/UserScript==

(() => {
	"use strict";

	const ANKI_URL = "http://127.0.0.1:8765";
	// "Word" fields of the JP note types in use. Must include the field of every
	// deck; a field missing from a note type simply never matches the search.
	const FIELDS = ["Word", "Expression", "Jlab-Kanji", "Jlab-Lemma"];
	const DECK_FILTER = "";
	const STATUS_COLORS = {
		new: "#e05c5c",
		learning: "#e0a83a",
		review: "#4caf7d",
		suspended: "#8a8a8a",
		buried: "#b06ab3",
	};
	// Precedence when the same word has cards in more than one deck.
	const STATUS_PRIORITY = ["review", "learning", "new", "suspended", "buried"];
	// Text color while a highlighted word is selected with the mouse. The selection
	// background is the status color itself; without this the browser uses the default
	// selection color, which clashes with the text color.
	const SELECTION_TEXT_COLOR = "#0b0b0b";
	// Morphological analysis by @libraz/suzume (Apache-2.0), vendored at the end of
	// this file: it gives each word boundary and the dictionary form (baseForm), which
	// is what matches the Anki Word field. The dictionary (.wasm, ~635KB) comes from
	// the pinned CDN and stays in the browser HTTP cache.
	const SUZUME_VERSION = "0.9.14";
	const SUZUME_WASM_URL = `https://cdn.jsdelivr.net/npm/@libraz/suzume@${SUZUME_VERSION}/dist/suzume.wasm`;
	const WASM_TIMEOUT_MS = 60000;
	// POS (uppercase, as suzume returns them) that never become a highlighted word:
	// a particle stays as it is; auxiliary/suffix glue to the end of the previous word
	// (まし + た) and prefix (お + 腹) to the start of the next.
	const SKIP_POS = new Set([
		"PARTICLE",
		"AUX",
		"PREFIX",
		"SUFFIX",
		"SYMBOL",
		"WHITESPACE",
		"FILLER",
	]);
	const DEBOUNCE_MS = 150;
	// CPU ceiling per pass: the analyzer costs ~150ms per 1000 chars, so the queue
	// yields the thread and continues on the next tick instead of freezing the page.
	const FRAME_BUDGET_MS = 50;
	const BATCH_MAX = 50;
	const CARDS_PER_WORD = 10;
	const BACKOFF_MS = 10000;
	const REQUEST_TIMEOUT_MS = 15000;
	const JP_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/;
	const MARK = "data-anki-word";
	const MAX_WORD_CHARS = 16;
	// POS that can form a compound with the next one (貴 + 様 -> 貴様).
	const JOINABLE_POS = new Set(["NOUN", "PRON"]);
	// kana->kanji bridge: the dictionary returns the lemma in kana (こない -> くる) while
	// the card may be in kanji (来る). The index is built from the readings of the cards
	// themselves (notesInfo in chunks) and stored in GM_setValue.
	const READING_FIELDS = [
		"Word Reading",
		"ExpressionReading",
		"WordReading",
		"Reading",
	];
	const READING_INDEX_KEY = "anki-jp-highlight:readings:v1";
	const INDEX_CHUNK = 800;
	// Let the page settle before pulling the collection to build the index.
	const INDEX_BUILD_DELAY_MS = 5000;
	const BRIDGE_MAX = 4;
	const KANA_ONLY_REGEX = /^[\u3040-\u309Fー]+$/;
	// A verb stem read in isolation comes back as a noun from suzume (食べ[NOUN], 見[NOUN]).
	// When no key matches, we try the dictionary form: + る (ichidan) and the i/a-row
	// kana mapped to the u-row (godan: 会い -> 会う, 買わ -> 買う).
	const KANA_TO_U = {
		い: "う",
		き: "く",
		し: "す",
		ち: "つ",
		に: "ぬ",
		み: "む",
		り: "る",
		び: "ぶ",
		ぎ: "ぐ",
		あ: "う",
		か: "く",
		さ: "す",
		た: "つ",
		な: "ぬ",
		ま: "む",
		ら: "る",
		ば: "ぶ",
		が: "ぐ",
		わ: "う",
	};
	const KANA_TAIL_REGEX = /[\u3041-\u3096ー]$/;
	const KANJI_TAIL_REGEX = /[\u4E00-\u9FFF々]$/;
	// On-disk cache (GM_setValue) expires daily: the first page of the day already
	// opens with no request for everything you queried before.
	const CACHE_KEY = "anki-jp-highlight:cache:v2";
	const CACHE_SAVE_MS = 2000;
	const CACHE_MAX_ENTRIES = 30000;
	const SKIP_TAGS = [
		"INPUT",
		"TEXTAREA",
		"SCRIPT",
		"STYLE",
		"NOSCRIPT",
		"SELECT",
	];
	// End of an inline text run: analysis breaks here (cell, paragraph...).
	// BR stays OUT on purpose: a line break does not separate words, and cutting the
	// run there isolates a stem (食べ + <br> + 行く -> 食[NOUN] and nothing is painted).
	const BLOCK_TAGS = new Set([
		"ADDRESS",
		"ARTICLE",
		"ASIDE",
		"BLOCKQUOTE",
		"CAPTION",
		"DD",
		"DETAILS",
		"DIALOG",
		"DIV",
		"DL",
		"DT",
		"FIELDSET",
		"FIGCAPTION",
		"FIGURE",
		"FOOTER",
		"FORM",
		"H1",
		"H2",
		"H3",
		"H4",
		"H5",
		"H6",
		"HEADER",
		"HR",
		"LI",
		"LEGEND",
		"MAIN",
		"MENU",
		"NAV",
		"OL",
		"P",
		"PRE",
		"SECTION",
		"SUMMARY",
		"TABLE",
		"TBODY",
		"TD",
		"TFOOT",
		"TH",
		"THEAD",
		"TR",
		"UL",
	]);

	const cache = new Map(); // dictionary form -> status | "" (no card)
	let done = new WeakMap(); // element -> processed textContent
	const dirty = new Set();
	const emptyProcessed = new WeakSet(); // elements with nothing paintable (avoids re-analysis)
	const waiting = new Set(); // elements with words not resolved yet
	const queueWords = new Set();
	const wordKeys = new Map(); // primary key -> every key of the unit

	let engine = null;
	let readingIndex = new Map(); // kana -> [kanji...] from the card readings
	let indexBuilding = false;
	let debounceTimer = null;
	let batchRunning = false;
	let backoffUntil = 0;
	const warned = new Set();
	let saveTimer = null;

	function warnOnce(message, error) {
		if (warned.has(message)) return;
		warned.add(message);
		console.warn(`[anki-jp-highlight] ${message}`, error ?? "");
	}

	function injectSelectionStyles() {
		const rules = Object.entries(STATUS_COLORS)
			.map(
				([status, color]) =>
					`[${MARK}="${status}"]::selection{background:${color};color:${SELECTION_TEXT_COLOR}}`,
			)
			.join("");
		const style = document.createElement("style");
		style.textContent = rules;
		(document.head ?? document.documentElement).append(style);
	}

	// Query keys of a unit: the dictionary form when the morpheme is a verb/adjective
	// (食べました -> 食べる), otherwise the text as read; the other form goes in as a
	// secondary key (お腹 -> 腹, 食べました -> 食べる).
	function keysFor(unit) {
		const inflected = unit.pos === "VERB" || unit.pos === "ADJ";
		const primary = inflected && unit.lemma ? unit.lemma : unit.surface;
		const keys =
			primary === unit.lemma || !unit.lemma ? [primary] : [primary, unit.lemma];
		// kana->kanji bridge: a form read only in kana may have its card in kanji (こない
		// -> くる -> 来る); the candidates come from the readings of the cards themselves.
		if (readingIndex.size && KANA_ONLY_REGEX.test(primary)) {
			for (const word of readingIndex.get(primary) ?? []) {
				if (!keys.includes(word)) keys.push(word);
			}
		}
		return keys;
	}

	function wordQuery(keys) {
		const terms = [];
		for (const key of keys) {
			const safe = key.replace(/"/g, "");
			for (const field of FIELDS) terms.push(`${field}:"${safe}"`);
		}
		const query = `(${terms.join(" OR ")})`;
		return DECK_FILTER ? `${DECK_FILTER} ${query}` : query;
	}

	function queryAnki(actions) {
		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method: "POST",
				url: ANKI_URL,
				headers: { "Content-Type": "application/json" },
				data: JSON.stringify({
					action: "multi",
					version: 6,
					params: { actions },
				}),
				timeout: REQUEST_TIMEOUT_MS,
				onload: (response) => {
					try {
						const body = JSON.parse(response.responseText);
						if (body.error) {
							reject(new Error(body.error));
							return;
						}
						resolve(
							body.result.map((entry) =>
								entry && !entry.error ? entry.result : null,
							),
						);
					} catch (error) {
						reject(error);
					}
				},
				onerror: () => reject(new Error("AnkiConnect is not reachable")),
				ontimeout: () => reject(new Error("AnkiConnect request timed out")),
			});
		});
	}

	// Anki queue: -1 suspended, -2/-3 buried, 0 new, 1/3 learning, 2 review.
	function statusFromQueue(queue) {
		if (queue === 0) return "new";
		if (queue === 1 || queue === 3) return "learning";
		if (queue === 2) return "review";
		if (queue === -1) return "suspended";
		if (queue === -2 || queue === -3) return "buried";
		return "";
	}

	function statusFromCards(cards) {
		if (!Array.isArray(cards)) return "";
		let best = "";
		let bestRank = STATUS_PRIORITY.length;
		for (const card of cards) {
			const status = statusFromQueue(card?.queue);
			if (!status) continue;
			const rank = STATUS_PRIORITY.indexOf(status);
			if (rank < bestRank) {
				bestRank = rank;
				best = status;
			}
		}
		return best;
	}

	function dayKey() {
		return new Date().toISOString().slice(0, 10);
	}

	function loadPersistentCache() {
		try {
			const raw = GM_getValue(CACHE_KEY, "");
			if (!raw) return;
			const saved = JSON.parse(raw);
			if (saved?.day !== dayKey()) return;
			for (const [word, status] of Object.entries(saved.entries ?? {})) {
				cache.set(word, status);
			}
		} catch (error) {
			warnOnce("stored status cache is unreadable; starting empty", error);
		}
	}

	function savePersistentCache() {
		if (saveTimer) return;
		saveTimer = setTimeout(() => {
			saveTimer = null;
			if (cache.size > CACHE_MAX_ENTRIES) return;
			try {
				GM_setValue(
					CACHE_KEY,
					JSON.stringify({ day: dayKey(), entries: Object.fromEntries(cache) }),
				);
			} catch (error) {
				warnOnce("could not persist the status cache", error);
			}
		}, CACHE_SAVE_MS);
	}

	function firstFieldValue(fields, names) {
		for (const name of names) {
			const value = fields?.[name]?.value?.trim();
			if (value) return value;
		}
		return null;
	}

	function fillReadingIndex(entries) {
		readingIndex = new Map(Object.entries(entries));
	}

	// Always reuse the stored index (even from another day); returns whether it is today's.
	function loadReadingIndex() {
		try {
			const raw = GM_getValue(READING_INDEX_KEY, "");
			if (!raw) return false;
			const saved = JSON.parse(raw);
			fillReadingIndex(saved.readings ?? {});
			return saved.day === dayKey();
		} catch (error) {
			warnOnce("stored kana->kanji index is unreadable; will rebuild", error);
			return false;
		}
	}

	function saveReadingIndex(entries) {
		const payload = { day: dayKey(), readings: entries };
		try {
			GM_setValue(READING_INDEX_KEY, JSON.stringify(payload));
		} catch (error) {
			warnOnce("could not persist the kana->kanji index", error);
		}
	}

	// Builds kana->kanji from the readings of the cards themselves, in chunks, yielding
	// the thread in between (~77MB of notesInfo for the whole collection).
	async function buildReadingIndex() {
		if (indexBuilding) return;
		indexBuilding = true;
		try {
			const query = `(${FIELDS.map((field) => `${field}:*`).join(" OR ")})`;
			const [notes] = await queryAnki([
				{ action: "findNotes", version: 6, params: { query } },
			]);
			const ids = Array.isArray(notes) ? notes : [];
			const entries = {};
			for (let start = 0; start < ids.length; start += INDEX_CHUNK) {
				const [infos] = await queryAnki([
					{
						action: "notesInfo",
						version: 6,
						params: { notes: ids.slice(start, start + INDEX_CHUNK) },
					},
				]);
				for (const note of infos ?? []) {
					const word = firstFieldValue(note.fields, FIELDS);
					const reading = firstFieldValue(note.fields, READING_FIELDS);
					if (!word || !reading || word === reading) continue;
					if (!KANA_ONLY_REGEX.test(reading)) continue;
					const words = (entries[reading] ??= []);
					if (words.length < BRIDGE_MAX && !words.includes(word))
						words.push(word);
				}
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			fillReadingIndex(entries);
			saveReadingIndex(entries);
			done = new WeakMap();
			dirty.add(document.body);
			process();
		} catch (error) {
			warnOnce("could not build the kana->kanji index", error);
		}
		indexBuilding = false;
	}

	async function runBatch() {
		if (batchRunning || queueWords.size === 0) return;
		if (Date.now() < backoffUntil) {
			setTimeout(runBatch, backoffUntil - Date.now());
			return;
		}
		batchRunning = true;
		const words = [...queueWords].slice(0, BATCH_MAX);
		for (const word of words) queueWords.delete(word);
		try {
			const findActions = words.map((word) => ({
				action: "findCards",
				version: 6,
				params: { query: wordQuery(wordKeys.get(word) ?? [word]) },
			}));
			const found = await queryAnki(findActions);
			const idsByWord = new Map(
				words.map((word, index) => [
					word,
					Array.isArray(found[index])
						? found[index].slice(0, CARDS_PER_WORD)
						: [],
				]),
			);
			const withIds = words.filter((word) => idsByWord.get(word).length > 0);
			const infos = withIds.length
				? await queryAnki(
						withIds.map((word) => ({
							action: "cardsInfo",
							version: 6,
							params: { cards: idsByWord.get(word) },
						})),
					)
				: [];
			// The status holds for every key of the unit: the read form and the dictionary
			// form share the card.
			withIds.forEach((word, index) => {
				const status = statusFromCards(infos[index]);
				for (const key of wordKeys.get(word) ?? [word]) cache.set(key, status);
			});
			for (const word of words) {
				if (idsByWord.get(word).length) continue;
				for (const key of wordKeys.get(word) ?? [word]) cache.set(key, "");
			}
			for (const word of words) wordKeys.delete(word);
			savePersistentCache();
		} catch (error) {
			warnOnce(
				`AnkiConnect query failed; backing off ${BACKOFF_MS / 1000}s`,
				error,
			);
			backoffUntil = Date.now() + BACKOFF_MS;
			for (const word of words) queueWords.add(word);
			batchRunning = false;
			setTimeout(runBatch, BACKOFF_MS);
			return;
		}
		batchRunning = false;
		const pending = [...waiting];
		waiting.clear();
		for (const element of pending) processElement(element, true);
		if (queueWords.size) runBatch();
	}

	function scheduleBatch() {
		if (!queueWords.size || batchRunning) return;
		runBatch();
	}

	function isSkipped(element) {
		return SKIP_TAGS.includes(element.tagName) || element.hasAttribute(MARK);
	}

	function markDirty(node) {
		if (!node) return;
		const element =
			node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
		if (element && !isSkipped(element)) dirty.add(element);
	}

	function queueWord(keys, element) {
		wordKeys.set(keys[0], keys);
		queueWords.add(keys[0]);
		waiting.add(element);
	}

	function unwrap(element) {
		const spans = element.querySelectorAll(`[${MARK}]`);
		for (const span of spans)
			span.replaceWith(document.createTextNode(span.textContent));
	}

	// An auxiliary (tense/negation helper) and a suffix (さん, たち) belong to the
	// previous word; a prefix (お, ご) belongs to the next one.
	function isAttaching(morpheme) {
		return (
			morpheme.extendedPos?.startsWith("AUX") ||
			morpheme.extendedPos?.startsWith("SUFFIX") ||
			morpheme.pos === "AUX" ||
			morpheme.pos === "SUFFIX"
		);
	}

	// Morphemes become paintable units: auxiliary/suffix join the end of the previous
	// word (まし + た), prefix joins the start of the next (お + 腹), a particle stays
	// out.
	function toUnits(text) {
		const { morphemes } = engine.analyzeWithNormalizedText(text);
		const units = [];
		let prefixStart = null;
		for (const morpheme of morphemes) {
			const start = morpheme.startUtf16;
			const end = morpheme.endUtf16;
			const raw = text.slice(start, end);
			// Dictionary normalization can shift offsets (ヴ, width, case).
			if (raw !== morpheme.surface) continue;
			const previous = units.at(-1);
			if (isAttaching(morpheme)) {
				if (previous && previous.end === start) previous.end = end;
				continue;
			}
			if (morpheme.pos === "PREFIX") {
				prefixStart = start;
				continue;
			}
			if (SKIP_POS.has(morpheme.pos)) {
				// A lone particle glued to the end (食|べ, 買|わ): the kana tells the conjugation
				// row and hints at the dictionary form.
				if (
					previous &&
					previous.end === start &&
					morpheme.pos === "PARTICLE" &&
					raw.length === 1
				) {
					previous.tail = raw;
					previous.tailEnd = end;
				}
				continue;
			}
			if (!JP_REGEX.test(raw) || raw.length > MAX_WORD_CHARS) continue;
			units.push({
				start: prefixStart ?? start,
				end,
				surface: text.slice(prefixStart ?? start, end),
				lemma: morpheme.baseForm || raw,
				pos: morpheme.pos,
			});
			prefixStart = null;
		}
		return units;
	}

	// Dictionary-form candidates for a stem (食べ -> 食べる, 会い -> 会う) and for the
	// kanji + kana the dictionary splits (買|わ -> 買う). `end` follows along because the
	// span may include the kana of the stem.
	function stemCandidates(unit) {
		const candidates = [];
		const push = (key, end) => candidates.push({ key, end });
		if (
			KANA_TAIL_REGEX.test(unit.surface) ||
			KANJI_TAIL_REGEX.test(unit.surface)
		) {
			push(`${unit.surface}る`, unit.end);
			const mapped = KANA_TO_U[unit.surface.at(-1)];
			if (mapped) push(unit.surface.slice(0, -1) + mapped, unit.end);
		}
		if (unit.tail) {
			push(`${unit.surface}${unit.tail}る`, unit.tailEnd);
			const mapped = KANA_TO_U[unit.tail];
			if (mapped) push(unit.surface + mapped, unit.tailEnd);
		}
		return candidates;
	}

	// Resolves the units of a run of text: returns the spans to paint (start/end/status)
	// and queues the lookup of what is not cached yet.
	function resolveUnits(text, units, element) {
		const paintings = [];
		let coveredUntil = 0;
		for (let index = 0; index < units.length; index += 1) {
			const unit = units[index];
			if (unit.start < coveredUntil) continue;
			const keys = keysFor(unit);
			let status;
			let pending = false;
			for (const key of keys) {
				const value = cache.get(key);
				if (value) {
					status = value;
					break;
				}
				if (value === undefined) pending = true;
			}
			if (pending) queueWord(keys, element);
			let end = unit.end;
			// A compound the dictionary splits (貴 + 様): when either half has no card, or was
			// not queried yet, try joining it with the next noun - the loose piece often matches
			// a card from another deck (proper noun).
			const next = units[index + 1];
			if (
				next &&
				next.start === end &&
				JOINABLE_POS.has(unit.pos) &&
				JOINABLE_POS.has(next.pos)
			) {
				const joined = text.slice(unit.start, next.end);
				if (joined.length <= MAX_WORD_CHARS) {
					const joinedStatus = cache.get(joined);
					if (joinedStatus) {
						status = joinedStatus;
						end = next.end;
					} else if (joinedStatus === undefined) {
						queueWord([joined], element);
					}
				}
			}
			// A stem the dictionary read as a noun (食べ, 見, 会い) that did not match: try the
			// dictionary form before giving up.
			if (!status && !pending) {
				const stems = stemCandidates(unit);
				let stemsPending = false;
				for (const stem of stems) {
					const stemStatus = cache.get(stem.key);
					if (stemStatus) {
						status = stemStatus;
						end = stem.end;
						break;
					}
					if (stemStatus === undefined) stemsPending = true;
				}
				if (!status && stemsPending) {
					queueWord(
						stems.map((stem) => stem.key),
						element,
					);
				}
			}
			if (!status) continue;
			coveredUntil = end;
			paintings.push({ start: unit.start, end, status });
		}
		return paintings;
	}

	// Wraps the slices of a single text node in spans (the slice may come from a run
	// that crosses several nodes).
	function wrapSlices(node, list) {
		const text = node.nodeValue;
		list.sort((left, right) => left.start - right.start);
		const fragment = document.createDocumentFragment();
		let cursor = 0;
		for (const slice of list) {
			if (slice.start < cursor) continue;
			const before = text.slice(cursor, slice.start);
			if (before) fragment.append(before);
			const span = document.createElement("span");
			span.setAttribute(MARK, slice.status);
			span.style.color = STATUS_COLORS[slice.status];
			span.style.textDecoration = "underline";
			span.textContent = text.slice(slice.start, slice.end);
			fragment.append(span);
			cursor = slice.end;
		}
		const after = text.slice(cursor);
		if (after) fragment.append(after);
		node.replaceWith(fragment);
	}

	// A run is loose text + consecutive inline spans of the page; it is analyzed as one
	// text (a page that cuts the word into spans: <span>買わ</span>ない) and returns the
	// slices for the source nodes.
	function paintRun(nodes, element) {
		if (!nodes.length) return false;
		let text = "";
		const offsets = [];
		for (const node of nodes) {
			offsets.push(text.length);
			text += node.nodeValue;
		}
		if (!JP_REGEX.test(text)) return;
		const pieces = resolveUnits(text, toUnits(text), element);
		if (!pieces.length) return false;
		const perNode = new Map();
		for (const piece of pieces) {
			for (let index = 0; index < nodes.length; index += 1) {
				const node = nodes[index];
				const base = offsets[index];
				const start = Math.max(piece.start, base);
				const end = Math.min(piece.end, base + node.nodeValue.length);
				if (start >= end) continue;
				const list = perNode.get(node) ?? [];
				list.push({
					start: start - base,
					end: end - base,
					status: piece.status,
				});
				perNode.set(node, list);
			}
		}
		for (const [node, list] of perNode) wrapSlices(node, list);
		return perNode.size > 0;
	}

	// Walks the inline content collecting text in state.run. A block in the middle -
	// even inside an inline (a > div, em > div) - closes the run and becomes its own
	// container (before, the text of those blocks was simply ignored).
	function walkInline(element, force, state) {
		for (const child of element.childNodes) {
			if (child.nodeType === Node.TEXT_NODE) {
				state.run.push(child);
				continue;
			}
			if (child.nodeType !== Node.ELEMENT_NODE || child.hasAttribute(MARK))
				continue;
			if (BLOCK_TAGS.has(child.tagName)) {
				state.painted = paintRun(state.run, state.owner) || state.painted;
				state.run = [];
				state.painted = processElement(child, force) || state.painted;
				continue;
			}
			walkInline(child, force, state);
		}
	}

	function processElement(element, force) {
		if (!element || !element.isConnected || isSkipped(element)) return false;
		if (!engine) return false;
		const text = element.textContent;
		// Skips only when nothing changed AND the markup survived in there (or we already
		// know there is nothing paintable): the page may have swapped the whole subtree
		// while keeping the same text (reader re-render).
		if (
			!force &&
			done.get(element) === text &&
			(emptyProcessed.has(element) || element.querySelector(`[${MARK}]`))
		)
			return false;
		unwrap(element);
		const state = { run: [], painted: false, owner: element };
		walkInline(element, force, state);
		const painted = paintRun(state.run, element) || state.painted;
		done.set(element, element.textContent);
		if (painted) emptyProcessed.delete(element);
		else emptyProcessed.add(element);
		return painted;
	}

	function process() {
		const deadline = performance.now() + FRAME_BUDGET_MS;
		while (dirty.size) {
			const element = dirty.values().next().value;
			dirty.delete(element);
			processElement(element);
			if (dirty.size && performance.now() >= deadline) {
				setTimeout(process, 0);
				break;
			}
		}
		scheduleBatch();
	}

	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type === "characterData")
				markDirty(mutation.target.parentElement);
			markDirty(mutation.target);
			for (const node of mutation.addedNodes) markDirty(node);
		}
		if (!dirty.size) return;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(process, DEBOUNCE_MS);
	});

	function startEngine() {
		GM_xmlhttpRequest({
			method: "GET",
			url: SUZUME_WASM_URL,
			responseType: "arraybuffer",
			timeout: WASM_TIMEOUT_MS,
			onload: (response) => {
				if (response.status !== 200 || !response.response) {
					warnOnce(
						`suzume dictionary download failed (HTTP ${response.status})`,
					);
					return;
				}
				const blobUrl = URL.createObjectURL(
					new Blob([response.response], { type: "application/wasm" }),
				);
				SuzumeLib.Suzume.create({ wasmPath: blobUrl })
					.then((created) => {
						URL.revokeObjectURL(blobUrl);
						engine = created;
						done = new WeakMap();
						dirty.add(document.body);
						process();
					})
					.catch((error) =>
						warnOnce(
							"suzume engine failed to start; nothing is highlighted until a reload",
							error,
						),
					);
			},
			onerror: () =>
				warnOnce("suzume dictionary download failed (network error)"),
			ontimeout: () => warnOnce("suzume dictionary download timed out"),
		});
	}

	GM_registerMenuCommand("Reload Anki status", () => {
		cache.clear();
		GM_setValue(CACHE_KEY, "");
		done = new WeakMap();
		dirty.add(document.body);
		process();
	});

	GM_registerMenuCommand("Rebuild kana->kanji index", () => {
		buildReadingIndex();
	});

	loadPersistentCache();
	if (!loadReadingIndex()) setTimeout(buildReadingIndex, INDEX_BUILD_DELAY_MS);
	observer.observe(document.body, {
		childList: true,
		subtree: true,
		characterData: true,
	});
	injectSelectionStyles();
	startEngine();

	// ---------------------------------------------------------------------------
	// Vendored: @libraz/suzume 0.9.14 (Apache-2.0), CJS bundle minified with
	// `import.meta.url` swapped for "about:blank" (the wasm comes from wasmPath).
	// Regenerate: bun build --minify --target=browser --format=cjs \
	//   <suzume>/dist/index.js --outfile=bundle.js  and swap import.meta.url.
	// License: https://github.com/libraz/suzume/blob/main/LICENSE (Apache-2.0).
	/* eslint-disable */
	const suzumeModule = { exports: {} };
	// prettier-ignore
	(function (module, exports) { var{defineProperty:Q,getOwnPropertyNames:Ct,getOwnPropertyDescriptor:Wt}=Object,Jt=Object.prototype.hasOwnProperty;function Vt(t){return this[t]}var $t=(t)=>{var r=(ie??=new WeakMap).get(t),s;if(r)return r;if(r=Q({},"__esModule",{value:!0}),t&&typeof t==="object"||typeof t==="function"){for(var i of Ct(t))if(!Jt.call(r,i))Q(r,i,{get:Vt.bind(t,i),enumerable:!(s=Wt(t,i))||s.enumerable})}return ie.set(t,r),r},ie;var Gt=(t)=>t;function Xt(t,r){this[t]=Gt.bind(null,r)}var Yt=(t,r)=>{for(var s in r)Q(t,s,{get:r[s],enumerable:!0,configurable:!0,set:Xt.bind(r,s)})};var Kt=(t,r,s)=>()=>{if(t)try{r=t(t=0)}catch(i){s=[i]}if(s)throw s[0];return r};async function Zt(t={}){var r=t,s=!!globalThis.window,i=!!globalThis.WorkerGlobalScope,u=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";if(u){let{createRequire:e}=await import("node:module");var l=e("file:///tmp/suzume-check/node_modules/@libraz/suzume/dist/suzume.js")}var a=[],c="./this.program",f=(e,n)=>{throw n},m="file:///tmp/suzume-check/node_modules/@libraz/suzume/dist/suzume.js",_="";function z(e){if(r.locateFile)return r.locateFile(e,_);return _+e}var b,L;if(u){var M=l("node:fs");if(m.startsWith("file:"))_=l("node:path").dirname(l("node:url").fileURLToPath(m))+"/";if(L=(e)=>{e=A(e)?new URL(e):e;var n=M.readFileSync(e);return n},b=async(e,n=!0)=>{e=A(e)?new URL(e):e;var o=M.readFileSync(e,n?void 0:"utf8");return o},process.argv.length>1)c=process.argv[1].replace(/\\/g,"/");a=process.argv.slice(2),f=(e,n)=>{throw process.exitCode=e,n}}else if(s||i){try{_=new URL(".",m).href}catch{}{if(i)L=(e)=>{var n=new XMLHttpRequest;return n.open("GET",e,!1),n.responseType="arraybuffer",n.send(null),new Uint8Array(n.response)};b=async(e)=>{var n=await fetch(e,{credentials:"same-origin"});if(n.ok)return n.arrayBuffer();throw Error(n.status+" : "+n.url)}}}var x=console.log.bind(console),v=console.error.bind(console),O,U=!1,w,A=(e)=>e.startsWith("file://");class h{}class X extends h{}var Y=!1;function E(){return W.buffer}function T(){if(ee?.buffer?.resizable)return;var e=E();ee=new Int8Array(e),Ae=new Int16Array(e),I=new Uint8Array(e),Le=new Uint16Array(e),Ue=new Int32Array(e),r.HEAPU32=Oe=new Uint32Array(e),Fe=new Float32Array(e),Se=new Float64Array(e),we=new BigInt64Array(e),Pe=new BigUint64Array(e)}function j(){}function k(){Y=!0,J.g()}function B(){}function H(e){e=`Aborted(${e})`,v(e),U=!0,e+=". Build with -sASSERTIONS for more info.";var n=new WebAssembly.RuntimeError(e);throw n}var C;function ge(){if(r.locateFile)return z("suzume.wasm");return new URL("suzume.wasm","file:///tmp/suzume-check/node_modules/@libraz/suzume/dist/suzume.js").href}function ye(e){if(L)return L(e);throw"both async and sync fetching of the wasm failed"}async function ze(e){if(!O)try{var n=await b(e);return new Uint8Array(n)}catch{}return ye(e)}async function pe(e,n){try{var o=await ze(e),d=await WebAssembly.instantiate(o,n);return d}catch(g){v(`failed to asynchronously prepare wasm: ${g}`),H(g)}}async function ve(e,n,o){if(!e&&!u)try{var d=fetch(n,{credentials:"same-origin"}),g=await WebAssembly.instantiateStreaming(d,o);return g}catch(p){v(`wasm streaming compile failed: ${p}`),v("falling back to ArrayBuffer instantiation")}return pe(n,o)}function Te(){var e={a:Bt};return e}async function be(){function e(p){return J=p.exports,kt(J),T(),J}function n(p){return e(p.instance)}var o=Te();C??=ge();var d=await ve(O,C,o),g=n(d);return g}class K{name="ExitStatus";constructor(e){this.message=`Program terminated with exit(${e})`,this.status=e}}var Ae,Ue,we,ee,Fe,Se,Le,Oe,Pe,I,De=()=>H(""),Ne=0,Ie=()=>{Ne=0},R={},te=(e)=>{if(e instanceof K||e=="unwind")return w;f(1,e)},re=()=>!0,ne=(e)=>{if(w=e,!re())U=!0;f(e,new K(e))},Re=(e,n)=>{w=e,ne(e)},Me=Re,xe=()=>{if(!re())try{Me(w)}catch(e){te(e)}},Ee=(e)=>{if(U)return;try{return e()}catch(n){te(n)}finally{xe()}},je=()=>performance.now(),ke=(e,n)=>{if(R[e])clearTimeout(R[e].id),delete R[e];if(!n)return 0;var o=setTimeout(()=>{delete R[e],Ee(()=>se(e,je()))},n);return R[e]={id:o,timeout_ms:n},0},Be=()=>2147483648,He=(e,n)=>Math.ceil(e/n)*n,Ce=(e)=>{var n=W.buffer.byteLength,o=(e-n+65535)/65536|0;try{return W.grow(o),T(),1}catch(d){}},We=(e)=>{var n=I.length;e>>>=0;var o=Be();if(e>o)return!1;for(var d=1;d<=4;d*=2){var g=n*(1+0.2/d);g=Math.min(g,e+100663296);var p=Math.min(o,He(Math.max(e,g),65536)),P=Ce(p);if(P)return!0}return!1},Je=new TextDecoder,Ve=(e,n,o,d)=>{var g=n+o;if(d)return g;while(e[n]&&!(n>=g))++n;return n},$e=(e,n,o)=>{if(!e)return"";var d=Ve(I,e,n,o);return Je.decode(I.subarray(e,d))},Ge=(e,n,o,d)=>{if(!(d>0))return 0;var g=o,p=o+d-1;for(var P=0;P<e.length;++P){var y=e.codePointAt(P);if(y<=127){if(o>=p)break;n[o++]=y}else if(y<=2047){if(o+1>=p)break;n[o++]=192|y>>6,n[o++]=128|y&63}else if(y<=65535){if(o+2>=p)break;n[o++]=224|y>>12,n[o++]=128|y>>6&63,n[o++]=128|y&63}else{if(o+3>=p)break;n[o++]=240|y>>18,n[o++]=128|y>>12&63,n[o++]=128|y>>6&63,n[o++]=128|y&63,P++}}return n[o]=0,o-g},Xe=(e,n,o)=>Ge(e,I,n,o),Ye=(e)=>{var n=0;for(var o=0;o<e.length;++o){var d=e.charCodeAt(o);if(d<=127)n++;else if(d<=2047)n+=2;else if(d>=55296&&d<=57343)n+=4,++o;else n+=3}return n};r.UTF8ToString=$e,r.stringToUTF8=Xe,r.lengthBytesUTF8=Ye;var Ke,Qe,Ze,qe,et,tt,rt,nt,st,it,ot,at,ut,lt,_t,ct,dt,mt,ft,ht,gt,yt,zt,pt,vt,Tt,bt,At,Ut,wt,Ft,St,Lt,Ot,Pt,Dt,Nt,It,Rt,se,Mt,xt,Et,jt,W;function kt(e){Ke=r._suzume_create=e.h,Qe=r._suzume_init_extended_options=e.i,Ze=r._suzume_init_tag_options=e.j,qe=r._suzume_create_with_extended_options=e.k,et=r._suzume_destroy=e.l,tt=r._suzume_set_mode=e.m,rt=r._suzume_mode=e.n,nt=r._suzume_analyze=e.o,st=r._suzume_analyze_n=e.p,it=r._suzume_result_free=e.q,ot=r._suzume_generate_tags=e.r,at=r._suzume_generate_tags_n=e.s,ut=r._suzume_generate_tags_with_options=e.t,lt=r._suzume_generate_tags_with_options_n=e.u,_t=r._suzume_tags_free=e.v,ct=r._suzume_load_user_dict=e.w,dt=r._suzume_load_user_dict_count=e.x,mt=r._suzume_load_binary_dict=e.y,ft=r._suzume_clear_user_dictionaries=e.z,ht=r._suzume_has_core_dictionary=e.A,gt=r._suzume_version=e.B,yt=r._suzume_last_error=e.C,zt=r._suzume_last_error_code=e.D,pt=r._suzume_conjugation_type_label=e.E,vt=r._suzume_extended_pos_label=e.F,Tt=r._suzume_conjugation_form_label=e.G,bt=r._suzume_pos_label=e.H,At=r._suzume_dictionary_warning_count=e.I,Ut=r._suzume_dictionary_warning=e.J,wt=r._suzume_sizeof_result=e.K,Ft=r._suzume_sizeof_morpheme=e.L,St=r._suzume_sizeof_tags=e.M,Lt=r._suzume_sizeof_tag_options=e.N,Ot=r._suzume_sizeof_extended_options=e.O,Pt=r._suzume_offsetof_result=e.P,Dt=r._suzume_offsetof_morpheme=e.Q,Nt=r._suzume_offsetof_tags=e.R,It=r._suzume_offsetof_tag_options=e.S,Rt=r._suzume_offsetof_extended_options=e.T,se=e.U,Mt=r._free=e.V,xt=r._malloc=e.W,Et=W=e.f,jt=e.__indirect_function_table}var Bt={e:De,d:Ie,a:ke,b:We,c:ne};async function Ht(){if(j(),U)return;k(),B()}var J=await be();return await Ht(),r}var le;var _e=Kt(()=>{le=Zt});var nr={};Yt(nr,{ErrorCode:()=>N,Suzume:()=>G,SuzumeError:()=>D,default:()=>sr,version:()=>rr});module.exports=$t(nr);var F={result:{size:16,morphemes:0,count:4,normalizedText:8,normalizedTextSize:12},morpheme:{size:36,surface:0,baseForm:4,start:8,end:12,score:16,pos:20,extendedPos:21,conjugationType:22,conjugationForm:23,flags:24,surfaceSize:28,baseFormSize:32},tags:{size:12,tags:0,pos:4,count:8},tagOptions:{size:20,posFilter:0,excludeBasic:1,useLemma:2,minLength:4,maxTags:8,excludeParticles:12,excludeAuxiliaries:13,excludeFormalNouns:14,excludeLowInfo:15,removeDuplicates:16},extendedOptions:{size:20,preserveVu:0,preserveCase:1,preserveSymbols:2,mode:3,lemmatize:4,mergeCompounds:5,skipUserDictionary:6,skipCoreDictionary:7,reportScorerConfig:8,skipEnvConfig:9,scorerOptionsJson:12,dataDirectory:16}};var Qt=["その他","名詞","動詞","形容詞","副詞","助詞","助動詞","接続詞","連体詞","代名詞","接頭辞","接尾辞","感動詞","記号","その他"],S={userDict:1,formalNoun:2,lowInfo:4,unknown:8,fromDictionary:16,conjugatable:32};function oe(t){return Qt[t]??"その他"}function ae(t,r,s,i,u,l){let a=t.HEAPU32,c=new Uint8Array(a.buffer),f=new Float32Array(a.buffer),m=F.result,_=F.morpheme,z=a[r+m.morphemes>>2],b=a[r+m.count>>2],L=a[r+m.normalizedText>>2],M=a[r+m.normalizedTextSize>>2],x=new TextDecoder,v=x.decode(new Uint8Array(a.buffer,L,M)),O=[0],U=0;for(let A of v)U+=A.length,O.push(U);let w=[];for(let A=0;A<b;A++){let h=z+A*_.size,X=a[h+_.surface>>2],Y=a[h+_.baseForm>>2],E=c[h+_.pos],T=c[h+_.flags],j=(T&S.conjugatable)!==0,k=a[h+_.start>>2],B=a[h+_.end>>2],H=a[h+_.surfaceSize>>2],C=a[h+_.baseFormSize>>2];w.push({surface:x.decode(new Uint8Array(a.buffer,X,H)),pos:l(E),baseForm:x.decode(new Uint8Array(a.buffer,Y,C)),posJa:oe(E),conjType:j?s(c[h+_.conjugationType]):null,conjForm:j?i(c[h+_.conjugationForm]):null,extendedPos:u(c[h+_.extendedPos]),start:k,end:B,startUtf16:O[k]??v.length,endUtf16:O[B]??v.length,isUserDict:(T&S.userDict)!==0,isFormalNoun:(T&S.formalNoun)!==0,isLowInfo:(T&S.lowInfo)!==0,isUnknown:(T&S.unknown)!==0,isFromDictionary:(T&S.fromDictionary)!==0,score:f[h+_.score>>2]})}return{normalizedText:v,morphemes:w}}function ue(t,r,s){let i=t.HEAPU32,u=new Uint8Array(i.buffer),l=F.tags,a=i[r+l.tags>>2],c=i[r+l.pos>>2],f=i[r+l.count>>2],m=[];for(let _=0;_<f;_++){let z=i[(a>>2)+_];m.push({tag:t.UTF8ToString(z),pos:s(u[c+_])})}return m}var N;(function(t){t[t.Success=0]="Success",t[t.InvalidUtf8=1]="InvalidUtf8",t[t.DictionaryLoadFailed=2]="DictionaryLoadFailed",t[t.FileNotFound=3]="FileNotFound",t[t.Parse=4]="Parse",t[t.OutOfMemory=5]="OutOfMemory",t[t.InvalidInput=6]="InvalidInput",t[t.Internal=7]="Internal"})(N||(N={}));class D extends Error{constructor(t,r=N.Internal){super(t);this.name="SuzumeError",this.code=r}}var Z=new Map;async function he(t,r){let s=await Promise.resolve().then(() => (_e(),{})),i={};if(t)i.locateFile=(c)=>c.endsWith(".wasm")?t:c;if(r)return le(i);let u=t??"",l=Z.get(u);if(l)return l;let a=le(i);Z.set(u,a);try{return await a}catch(c){throw Z.delete(u),c}}var V={normal:0,search:1,split:2},qt=Object.fromEntries(Object.keys(V).map((t)=>[V[t],t])),ce={preserveVu:!0,preserveCase:!0,preserveSymbols:!1,mode:"normal",lemmatize:!0,mergeCompounds:!1,skipUserDictionary:!1,skipCoreDictionary:!1,skipEnvConfig:!1,reportScorerConfig:!1,scorerOptions:null,dataDirectory:null},de=["preserveVu","preserveCase","preserveSymbols","lemmatize","mergeCompounds","skipUserDictionary","skipCoreDictionary","skipEnvConfig","reportScorerConfig"],q={posFilter:0,excludeBasic:!1,useLemma:!0,minLength:2,maxTags:0,excludeParticles:!0,excludeAuxiliaries:!0,excludeFormalNouns:!0,excludeLowInfo:!0,removeDuplicates:!0},er=["excludeBasic","useLemma","excludeParticles","excludeAuxiliaries","excludeFormalNouns","excludeLowInfo","removeDuplicates"],me={noun:1,verb:2,adjective:4,adverb:8,particle:16,auxiliary:32};function tr(t){let r=t.posFilter!==void 0?t.posFilter:t.pos,s=0;for(let i of r??[]){let u=me[i];if(u===void 0)throw Error(`unknown POS filter name: ${JSON.stringify(i)} (expected one of ${Object.keys(me).sort().join(", ")})`);s|=u}return s}var fe=new FinalizationRegistry((t)=>{if(t.handle!==0)t.module._suzume_destroy(t.handle),t.handle=0});class G{constructor(t,r){this._posLabels=new Map,this._conjugationTypeLabels=new Map,this._conjugationFormLabels=new Map,this._extendedPosLabels=new Map,this.layouts=F,this.unregisterToken={},this.module=t,this.handle=r,this.cleanupRef={module:t,handle:r},fe.register(this,this.cleanupRef,this.unregisterToken)}static async create(t){let r=t?.wasmPath,s=await he(r,t?.freshWasmModule===!0),i;if(t&&(de.some((u)=>t[u]!==void 0)||t.mode!==void 0||t.scorerOptions!==void 0)){let u=F.extendedOptions,l=u.size,a=s._malloc(l),c=0;try{s._suzume_init_extended_options(a);let f=new Uint8Array(s.HEAPU32.buffer),m=t.mode??ce.mode,_=V[m];if(_===void 0)throw Error(`Invalid Suzume mode: ${String(t.mode)}`);f[a+u.mode]=_;for(let z of de)f[a+u[z]]=t[z]??ce[z]?1:0;if(t.scorerOptions!==void 0){let z=typeof t.scorerOptions==="string"?t.scorerOptions:JSON.stringify(t.scorerOptions),b=s.lengthBytesUTF8(z)+1;c=s._malloc(b),s.stringToUTF8(z,c,b),s.HEAPU32[a+u.scorerOptionsJson>>2]=c}i=s._suzume_create_with_extended_options(a)}finally{if(c!==0)s._free(c);s._free(a)}}else i=s._suzume_create();if(i===0){let u=s.UTF8ToString(s._suzume_last_error());throw new D(u?`Failed to create Suzume instance: ${u}`:"Failed to create Suzume instance",s._suzume_last_error_code())}return new G(s,i)}analyze(t){return this.analyzeWithNormalizedText(t).morphemes}get mode(){this.ensureAlive();let t=qt[this.module._suzume_mode(this.handle)];if(t===void 0)throw this.nativeError("mode query failed");return t}set mode(t){this.ensureAlive();let r=V[t];if(r===void 0)throw Error(`Invalid Suzume mode: ${String(t)}`);if(this.module._suzume_set_mode(this.handle,r)!==1)throw this.nativeError("mode change failed")}analyzeWithNormalizedText(t){return this.ensureAlive(),this.withUtf8String(t,(r,s)=>{let i=this.module._suzume_analyze_n(this.handle,r,s-1);if(i===0)throw this.nativeError("analyze failed");try{return this.parseResult(i)}finally{this.module._suzume_result_free(i)}})}generateTags(t,r){return this.ensureAlive(),this.withUtf8String(t,(s,i)=>{if(r){let u=tr(r),l=this.module._malloc(this.layouts.tagOptions.size);try{this.module._suzume_init_tag_options(l);let a=this.module.HEAPU32,c=new Uint8Array(a.buffer),f=this.layouts.tagOptions;c[l+f.posFilter]=u&255,a[l+f.minLength>>2]=r.minLength??q.minLength,a[l+f.maxTags>>2]=r.maxTags??q.maxTags;for(let m of er)c[l+f[m]]=r[m]??q[m]?1:0;return this.consumeTags(this.module._suzume_generate_tags_with_options_n(this.handle,s,i-1,l))}finally{this.module._free(l)}}return this.consumeTags(this.module._suzume_generate_tags_n(this.handle,s,i-1))})}loadUserDictionary(t){return this.loadUserDictionaryCount(t)>0}loadUserDictionaryCount(t){return this.ensureAlive(),this.withUtf8String(t,(r,s)=>this.module._suzume_load_user_dict_count(this.handle,r,s-1))}loadUserDictionaryOrThrow(t){if(!this.loadUserDictionary(t))throw this.nativeError("user dictionary load failed")}loadBinaryDictionary(t){this.ensureAlive();let r=this.module._malloc(t.byteLength);try{let s=this.module.HEAPU32;return new Uint8Array(s.buffer).set(t,r),this.module._suzume_load_binary_dict(this.handle,r,t.byteLength)===1}finally{this.module._free(r)}}loadBinaryDictionaryOrThrow(t){if(!this.loadBinaryDictionary(t))throw this.nativeError("binary dictionary load failed")}clearUserDictionaries(){if(this.ensureAlive(),this.module._suzume_clear_user_dictionaries(this.handle)!==1)throw this.nativeError("dictionary clear failed")}get version(){let t=this.module._suzume_version();return this.module.UTF8ToString(t)}get lastError(){return this.module.UTF8ToString(this.module._suzume_last_error())}get lastErrorCode(){return this.module._suzume_last_error_code()}wasmMemoryBytes(){return this.ensureAlive(),this.module.HEAPU32.buffer.byteLength}get dictionaryWarnings(){this.ensureAlive();let t=this.module._suzume_dictionary_warning_count(this.handle),r=[];for(let s=0;s<t;s++){let i=this.module._suzume_dictionary_warning(this.handle,s);if(i!==0)r.push(this.module.UTF8ToString(i))}return r}get hasCoreDictionary(){return this.ensureAlive(),this.module._suzume_has_core_dictionary(this.handle)===1}destroy(){if(this.handle!==0)fe.unregister(this.unregisterToken),this.module._suzume_destroy(this.handle),this.handle=0,this.cleanupRef.handle=0}ensureAlive(){if(this.handle===0)throw Error("Suzume instance has been destroyed")}withUtf8String(t,r){for(let u=0;u<t.length;u++){let l=t.charCodeAt(u);if(l>=55296&&l<=56319){let a=t.charCodeAt(u+1);if(a<56320||a>57343)throw new D("Input contains an unpaired UTF-16 surrogate",N.InvalidUtf8);u++}else if(l>=56320&&l<=57343)throw new D("Input contains an unpaired UTF-16 surrogate",N.InvalidUtf8)}let s=this.module.lengthBytesUTF8(t)+1,i=this.module._malloc(s);try{return this.module.stringToUTF8(t,i,s),r(i,s)}finally{this.module._free(i)}}consumeTags(t){if(t===0)throw this.nativeError("tag generation failed");try{return this.parseTags(t)}finally{this.module._suzume_tags_free(t)}}parseResult(t){return ae(this.module,t,(r)=>this.conjugationTypeLabel(r),(r)=>this.conjugationFormLabel(r),(r)=>this.extendedPosLabel(r),(r)=>this.posLabel(r))}parseTags(t){return ue(this.module,t,(r)=>this.posLabel(r))}posLabel(t){return this.cachedLabel(this._posLabels,this.module._suzume_pos_label,t,"OTHER")}conjugationTypeLabel(t){return this.cachedLabel(this._conjugationTypeLabels,this.module._suzume_conjugation_type_label,t,null)}conjugationFormLabel(t){return this.cachedLabel(this._conjugationFormLabels,this.module._suzume_conjugation_form_label,t,null)}extendedPosLabel(t){return this.cachedLabel(this._extendedPosLabels,this.module._suzume_extended_pos_label,t,"UNKNOWN")}cachedLabel(t,r,s,i){let u=t.get(s);if(u!==void 0)return u;let l=r(s),a=l===0?i:this.module.UTF8ToString(l);return t.set(s,a),a}nativeError(t){return new D(`Suzume ${t}: ${this.lastError||"unknown error"}`,this.lastErrorCode)}}var sr=G;async function rr(t){let r=await he(t?.wasmPath,t?.freshWasmModule===!0);return r.UTF8ToString(r._suzume_version())} })(suzumeModule, suzumeModule.exports);
	/* eslint-enable */
	const SuzumeLib = suzumeModule.exports;
})();
