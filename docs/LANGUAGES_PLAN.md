# Plan: Languages as separate files, loaded on demand

## Status

**Phases 1 and 2 built**, branch `language` in the client and the server. Phases 3 and 4 not started.

- One `language`, fixed from `?lang=` when `core.js` loads; `preferedLanguages`, `preferedLanguageSet`
  and the `lang` attribute on `mqtt-wrapper`, `mqtt-admin` and `mqtt-login` are gone. The plan's
  helper for that attribute turned out unnecessary: `core.js` reads `?lang=` itself, and a language
  cannot change without a reload, so the attribute only duplicated it.
- `languages/{en,fr,hi,id}.yaml`, checked equal to the old table. `en.yaml` maps every key to
  itself: the status codes are turned into text by `STATUS_TEXT` in `cards.js`, `nodeconfig.js`
  pushes the full message instead of `Project name length`, and `hysterisis` is gone.
- `document.documentElement.lang` is set to the language, for screen readers and font choice.
- `getString` returns a tag that is not a string unchanged. The old code only ever looked such a tag
  up in a table; the word-by-word step calls `.includes` on it, which threw in `page.test.js`.
- The service worker (server) caches a language file when first used, instead of at install.
- Text direction is not in the index yet; it waits for the first right-to-left language (Phase 4).

## Goal

The language table in `core.js` is 94 KB of a 190 KB file: four languages × 341 keys, every page
loading all four to show one. Move each language into its own file and load only the one in use.

The four current languages (EN, FR, HI, ID) were placeholders that proved the mechanism. The real
aim is to make **adding a language cheap**: a new file and one line in an index, no growth in what
every page downloads. Phase 4 is that expansion.

## Why not `config.d`

`config.d` is merged by the server into `/config.json`, which every page fetches whole. Languages
there would be downloaded together again, just from a different place. The files belong to the
client, which ships the code that uses the keys. They are served from the client directory, next to
the modules.

## What the code relies on now

- **A language change reloads the page.** The picker calls `locationParameterChange`, which sets
  `window.location`. So the language is known when `core.js` loads and never changes while a page is
  open. There is no live switching to support.
- **`getString` is synchronous** and is called from `render()` throughout. Whatever loads the file
  must finish before the first element renders.
- **Only `/dashboard/` and `/dashboard/index.html` need a login** (`shouldIBeLoggedIn` in
  `frugal-iot-server.js`). `/dashboard/languages/fr.yaml` is reachable from `login.html` with no
  server change.
- **Keys are English text.** Apart from the two index entries, every English entry maps a key to
  itself, so an English page needs no file at all.
- **`preferedLanguages` is a list**, built on the assumption that a language might be partly
  translated and fall through to the next. That assumption is dropped (D-1).

## Phase 1 — one language, not a list

- Replace `preferedLanguages` with a single `language` (a code such as `fr`) and `languageSet(code)`.
  It is exported read-only, as an imported binding cannot be assigned. This removes the class of bug
  fixed in `admin.js`.
- `getString(tag)` looks in the one table. On a miss, a tag with spaces is translated word by word,
  and a word that is not found is shown as itself (D-5). Otherwise the tag is shown, which is
  English.
- The `lang` attribute handling is copied three times (`MqttWrapper`, `MqttAdmin`, `MqttLogin`).
  Make it one helper in `core.js`. A legacy comma list (`?lang=FR,EN`) takes its first entry.
- `Intl.RelativeTimeFormat` reads `language` instead of `preferedLanguages[0]`.
- Codes are lowercase BCP 47 (`fr`, `pt-BR`) internally. `?lang=` accepts either case, because
  the server and old links send `EN`.

## Phase 2 — the files and the loader

- `languages/fr.yaml`, `hi.yaml`, `id.yaml`, moved verbatim out of `core.js`. YAML, so a translator
  can edit one without escaping backticks, and it matches `config.d/schema`.
- **English has no runtime file** (D-4). When `language` is `en`, nothing is fetched.
- **`languages/en.yaml` is the catalogue**: every key, each mapped to itself. It is never fetched.
  A translator copies it and replaces the values. The completeness test checks other files against
  it, and a new string is added there first.
- **Load with top-level `await` in `core.js`**: fetch
  `new URL('languages/' + language + '.yaml', import.meta.url)`, parse with js-yaml, and merge through
  `addVocabulary`. Every module importing `core.js` waits for it, so `getString` stays synchronous
  and no `render()` changes. The cost is one ~20 KB request before elements are defined, on
  non-English pages only, cached after that (ETag gives a 304).
  - The alternative was a "languages ready" callback that each entry point (wrapper, login, embedded
    pages) waits on before rendering. That touches every page, and missing one shows English
    silently.
- **A failed load never blocks the page.** On a 404 or a parse error, log with `XXX` and carry on
  with an empty table. Every string then shows its key, which is English.
- **A small index in `core.js`** lists the languages that exist: code, native name (today's
  `_thisLanguage`), flag, and text direction. The picker reads it instead of each language's
  `_nameAndFlag`, and the loader fetches only codes it lists.
- `addVocabulary` in dashboards keeps working unchanged. It merges, so vocabulary for a language not
  in use is held and never read. A dashboard's EN block becomes optional.
- **Service worker**: `frugal-iot-server/public/service-worker.js` precaches the dashboard's code.
  English needs nothing added. Precaching every language is waste with a long list; cache the one
  fetched instead, at runtime, and bump `CACHE_NAME` for the change.

## Phase 3 — the browser's language, and counting what is asked for

**Choosing**, on every page, in `core.js`:

1. `?lang=` if it is given and the index has it.
2. Otherwise, the first of `navigator.languages` that the index has. Match exactly first, then on
   the primary subtag: `pt-BR` → `pt-BR`, then `pt`. `fr-CA` → `fr`.
3. Otherwise `en`.

`login.html` makes this choice like any other page. It always sends the resolved code in its hidden
`lang` field, so the redirect after login carries the browser's language when it is supported and
`EN` when it is not. The server's own `|| "EN"` stays as the last resort for a form that sent none.

Optional: remember an explicit choice from the picker in `localStorage`, so it survives a link
without `?lang=`. It sits between steps 1 and 2. It is a per-viewer convenience, and losing it just
falls back to the browser's language.

**Counting**, to decide which languages to add next:

- `login.html` also sends `navigator.languages`, as a hidden `browserlangs` field.
- The server logs it on each login and counts each code in a table in `frugal-iot.db`:
  code, count, last seen, and whether it was supported then. Only the codes are stored, with no
  user, so the table shows what is asked for and not who asked.
- Counted per login, not per page view, so one busy user does not outweigh many occasional ones.
- Reading it is an SQL query at first. A section in `mqtt-admin` can come later.
- Server work is in `frugal-iot-server`: the login handler, the table in `frugal-iot-createdb.sql`,
  and the redirect.

## Phase 4 — more languages

The point of the work. Adding one is a file plus an index line. What makes it harder than that:

- **Which ones.** Driven by the Phase 3 counts once they exist, and before that by where Frugal IoT
  is deployed. Candidates include Spanish, Portuguese, Swahili, Bengali, Marathi, Tamil, Telugu,
  Nepali, Arabic, Vietnamese, Thai, Tagalog and Chinese.
- **Keeping forty files complete.** A new string goes into `en.yaml` and is machine-translated into
  every supported language in the same change, which is trivial whether done by hand or by Claude.
  So the test requires every language to have every `en.yaml` key (D-7). If a language is ever added
  that has no machine translation available, that test is what changes.
- **Right-to-left** (Arabic, Urdu, Farsi, Hebrew). Set `dir` from the index on `<html>`. Then check
  the cards: `frugaliot.css` uses physical `left`/`right` and margins, which want logical
  properties (`inline-start`). Each shadow root inherits `dir`, but a rule that hard-codes a side
  does not flip.
- **Flags are not languages.** Spanish, Arabic, Portuguese and English are each spoken in many
  countries. With a long list, show the native name and drop the flag, or keep the flag only where
  it is unambiguous. `compact` mode on the picker shows only the flag, so it needs another answer,
  such as the code.
- **Fonts.** Devanagari already works from system fonts. Check each new script on an ordinary
  Android phone, which is the likely device, before shipping it.
- **Translation workflow.** A machine draft reviewed by a native speaker. Mark each file
  `_status: draft | reviewed`, so a draft can ship labelled as one.
- **Strings that will not survive translation as they are.** `getStringWith` takes one `%s`. Plurals
  ("1 node" / "3 nodes") need `Intl.PluralRules` once a language has more than two forms. Numbers
  in `mt.formatted` use a `.` decimal point; many of these languages use `,`
  (`Intl.NumberFormat`). Find these before translating, not during.

## Tests

- Every key in `en.yaml` is in every language file; the test fails and names the language and the
  key. A key in a language file but not in `en.yaml` (a typo, or a string that was removed) also
  fails.
- Every code in the index has a file (except `en`), and every file is in the index.
- The loader: `?lang=fr` gives French, an unknown code gives English, a failed fetch still renders,
  and `en` fetches nothing.
- Browser matching: `fr-CA` → `fr`, an unsupported language → `en`, and `?lang=` overrides both.
- Word-by-word: a phrase not in the table translates the words that are, and leaves the rest.
- `test/setup.js` needs `fetch` to handle `file:` URLs (Node's does not), by reading the file.

## Decisions

- **D-1** A language has all its strings or none, as a target. No list of preferences. A missing
  string shows its key, which is English.
- **D-2** Language files live in the client (`languages/`), not `config.d`.
- **D-3** Loaded by top-level `await` in `core.js`, so `getString` stays synchronous.
- **D-4** Keys are English text, so English has no runtime file. `en.yaml` is the catalogue, never
  fetched. A code that needs a different display string (a status, a validation problem) maps it to
  English text where it is displayed, not in the table.
- **D-5** Word-by-word translation stays. Some strings reach `getString` by routes the client does
  not control, such as schema names and node-reported values. Translating each word is imperfect but
  usually understandable, and a word that does not translate is shown as itself.
- **D-6** Schema names (modules, topics, devices in `config.d/schema`) will not all be in the
  catalogue. They are translated word by word or shown in English. Adding them is ordinary
  catalogue work, prompted by the `XXX` "cannot translate" log.
- **D-7** A string added to `en.yaml` is translated into every supported language in the same
  change, and the test enforces it. This is the mechanism behind D-1.

## Open questions

None at present.
