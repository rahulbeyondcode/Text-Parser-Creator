# Message Parser: implementation and reuse guide

This document describes the **current implementation** of the Message Parser app so it can be understood or recreated in another repository. It covers all three original source files (`index.html`, `script.js`, and `styles.css`), their interactions, the behavior visible to users, and the constraints that matter when porting it. It is not a proposal for features that do not exist.

## 1. What the app does

The app lets a user create JavaScript parsers for particular kinds of SMS, email, or other messages, save them in the current browser, and paste a message to get a JSON result. The user does **not** need a server or API key: they supply examples, take a generated instruction prompt to an external AI service themselves, paste the resulting JavaScript back, and save it after the app tests it.

There are two primary journeys:

1. **Create a parser:** provide 2–10 examples of the same message type → generate/copy a prompt → ask an external AI to write `parseMessage(message)` → paste the code, name it, and test it against every example → save it locally.
2. **Parse a message:** paste text (at most 10,000 characters in the main input) → normalize it → run every saved parser → show the first matching parser's JSON or an error → optionally copy the JSON.

Other supported actions: fill the input with a sample shipping email, see a live character count and saved-parser count, remove a saved parser after confirmation, copy the generated prompt, and open links to ChatGPT Temporary or Claude Incognito. **The sample email is not accompanied by a built-in parser.** Until a matching parser is saved it will not parse successfully.

## 2. Repository and runtime inventory

| File | Responsibility |
| --- | --- |
| `index.html` (275 lines) | Semantic page structure, accessible labels, input and result views, three-step builder dialog, external AI links, Google Fonts links, and script/style loading. |
| `script.js` (571 lines) | All app state, input normalization, browser storage, prompt generation, dynamically generated worker execution, validation, UI rendering, and event listeners. |
| `styles.css` (1,212 lines) | Tokens, page layout, controls, output and dialog styling, responsive breakpoints, hidden-state behavior, and reduced-motion support. |

There are no other application files, dependencies, package manifest, framework, transpiler, test suite, backend, API routes, service worker, or bundled parser templates in this repository. JavaScript runs directly as a non-module script at the end of `index.html`; DOM nodes exist when the script executes. The only externally requested assets are the two Google Font families (`DM Mono`, `Manrope`); the CSS has generic fallbacks. Messages and parser code are not transmitted to this app's server because there is no app server, but **copying examples to an external AI shares them with that provider**. The AI links open external sites and do not call an AI API directly.

For local use, serve these files from a normal HTTP(S) origin (for example, with a static-file server). This keeps `localStorage`, clipboard permissions, and blob-backed Web Workers in a predictable origin and avoids browser-specific `file://` restrictions. Deploy as static files with browser support for `<dialog>`, `Worker`, `Blob`, `URL.createObjectURL`, `localStorage`, and the required modern JavaScript features.

## 3. Architecture at a glance

```text
index.html (elements and IDs) ─── styles.css (layout and states)
              │
              ▼
script.js (global in-memory state + DOM event listeners)
  ├─ parser library ─────── localStorage["message-parser-library-v1"]
  ├─ builder examples ───── generated text prompt ── clipboard / external AI (manual)
  ├─ save tests ─────────── runParser() ───────────── one Blob Web Worker per example
  └─ parse form ─────────── findMatchingParser() ── one Blob Web Worker per saved parser
                                                     │
                                                     ▼
                                            JSON or no match/error
```

The app has **no parser-selection classifier**. Each saved parser is tried, all at once, and the earliest saved parser whose worker reports `matched: true` wins. Matching logic and output schema come from the user's saved JavaScript, not from this application's fixed rules.

### In-memory state and constants (`script.js:1–53`)

| Name | Meaning |
| --- | --- |
| `STORAGE_KEY` | `message-parser-library-v1`, the browser storage namespace. |
| `MIN_EXAMPLES`, `MAX_EXAMPLES` | Two initial/mandatory example fields and a maximum of ten. |
| `PARSER_TIMEOUT_MS` | 1,500 ms per worker execution; timed-out workers are terminated. |
| `parsers` | Array loaded at startup from `localStorage`; changes are saved explicitly. |
| `examples` | Transient array of draft example strings, initially `['', '']`; not persisted. |
| `errorAction` | Determines whether the result panel's action button opens the builder or resets the result. |
| `states` | References to the four mutually exclusive output panels: empty, loading, success, error. |
| `sampleMessage` | Hard-coded demonstration shipping email; fills input only. |

The initial calls at the bottom of `script.js` render the library and the two initial example fields. No parser ships with the app.

## 4. HTML structure and element contracts

The `script.js` selectors depend on the IDs, `.dialog-step` classes, and `data-*` attributes listed here. Preserve them or update the selectors together when porting.

### Main page (`index.html:1–160`)

- The `<head>` defines language/encoding, viewport, description, title, font preconnect/import, and `styles.css`. The script is loaded just before `</body>` at line 273.
- `<main class="page-shell">` contains the site header, hero, parser library, two-panel workspace, and footer. The header includes the `#parser-count` badge and `#header-add-parser` button; the logo is a `href="#"` anchor.
- The library contains `#library-description`, the empty `#parser-chips` rendering target, and `#library-add-parser`. Chips are created at runtime, not in HTML.
- The left workspace panel is `<form id="parser-form">`: `#message-input` is a required textarea with `maxlength="10000"`; `#sample-button` fills it, `#character-count` displays its length, and `#submit-button` submits it. There is a screen-reader-only label for the textarea.
- The right panel contains `#output-content` with `aria-live="polite"`, and four existing views: `#empty-state`, `#loading-state`, `#success-state`, `#error-state`. All but empty start `hidden`. On success, `#matched-parser-label` identifies the parser, `#json-output` holds formatted JSON inside `<pre><code>`, and `#copy-button` becomes available. On error, `#error-title`, `#error-message`, and `#error-action-button` provide contextual feedback; the error container has `role="alert"`.
- Footer text says messages are processed locally and repeats the 10,000-character main-input limit.

### Builder dialog (`index.html:162–271`)

- A native modal `<dialog id="parser-dialog" aria-labelledby="dialog-title">` is opened with `showModal()` and closed by `#close-dialog`, clicking its backdrop, or native dialog behavior such as Escape.
- The progress bar has three `.progress-item[data-progress="1|2|3"]` entries: Examples, Ask AI, Save parser. Actual page segments are `.dialog-step[data-step="1|2|3"]`; only step 1 starts visible.
- **Step 1:** `#examples-list` receives dynamic labeled textareas; `#example-count` and `#add-example` track the count; `#generate-prompt` validates and advances. A note warns against putting sensitive data in examples.
- **Step 2:** `#generated-prompt` is a read-only textarea, `#copy-prompt` copies it, `#open-chatgpt` and `#open-claude` open new tabs with `rel="noopener noreferrer"`, `#continue-to-code` advances, and `[data-back="1"]` returns. The URLs carry temporary/incognito query parameters; the app asks the user to verify the mode in the destination UI.
- **Step 3:** `#parser-name` is a text input with `maxlength="60"`; `#parser-code` is a free-form JavaScript textarea; `#parser-form-error` displays validation failures; `#save-parser` tests/saves; `[data-back="2"]` returns. A warning states that only trusted code should be saved.

The builder is **not an HTML form**: its buttons have dedicated click listeners, and its required-example flags do not themselves trigger native form submission. The script explicitly checks cleaned example values when advancing.

## 5. Detailed behavior and implementation

### 5.1 Loading, rendering, and deleting parsers (`script.js:55–129`)

`loadParsers()` reads the key from `localStorage`, parses JSON, returns the array if the result is an array, and otherwise returns `[]`; JSON/storage-read failures are caught. It does not validate individual saved entries or migrate old formats. `persistParsers()` simply calls `localStorage.setItem` with `JSON.stringify(parsers)`; failures such as unavailable storage/quota are **not** caught.

`renderParserLibrary()` clears `#parser-chips`, creates a chip per saved entry with a text name, title, delete button and accessible delete label, then updates singular/plural count and explanatory copy. Displaying a name with `textContent` prevents interpreting it as HTML. `deleteParser(id)` looks it up, asks for confirmation using `window.confirm`, filters the array, persists, and rerenders. There is no edit, rename, import/export, reorder, or undo UI.

Saved parser shape (an example; code is stored verbatim after cleaning):

```json
{
  "id": "uuid-or-timestamp-string",
  "name": "Bank transaction alerts",
  "code": "function parseMessage(message) { /* ... */ }",
  "createdAt": "2026-09-25T12:00:00.000Z"
}
```

`id` uses `crypto.randomUUID()` where available, falling back to `String(Date.now())`; the fallback can collide if two parsers are saved within the same millisecond. `createdAt` is stored but not displayed or used for sorting. Browser storage is scoped to the site's origin/browser profile; it is not shared between devices or automatically backed up. Deleting a chip changes stored data but does not proactively clear an already displayed result.

### 5.2 Normalization (`script.js:131–162`)

The app cleans strings before building the prompt, testing a parser, and parsing a message:

| Function | Operations and implications |
| --- | --- |
| `cleanMessage(message)` | Coerces `null`/`undefined` to empty string; applies Unicode NFKC normalization; turns CRLF and CR into LF; strips selected ASCII control codes (but not LF and TAB), zero-width/directional formatting characters and BOM; changes non-breaking spaces to regular spaces; trims each line; strips outside blank lines; collapses three or more newlines to two; trims surrounding whitespace and replacement characters (`U+FFFD`). Thus a parser generally sees **normalized text, not exact original bytes**. |
| `cleanParserName(name)` | Coerces to string, NFKC-normalizes, strips control and selected invisible characters, collapses whitespace, trims. The HTML input's 60-character limit applies to entered text, not necessarily the final expanded NFKC string. |
| `cleanParserCode(code)` | Coerces to string, normalizes line endings, removes selected invisible characters, trims, removes an optional opening `` ```javascript ``/`` ```js ``/`` ``` `` and a closing code fence, then trims again. It does not parse, lint, or statically restrict JavaScript. |

`cleanMessage()` is also called **inside** `runParser()`. The examples are already cleaned before prompt generation, and are cleaned again when tested. The main textarea is replaced with its cleaned value on submit, so the character counter may change.

### 5.3 Running saved code (`script.js:164–228`)

`runParser(parser, message)` creates JavaScript source as a string, wraps it in a `Blob` URL, starts a new dedicated `Worker`, sets a 1,500 ms timeout, and posts `{ code: parser.code, message: cleanMessage(message) }`. Each invocation creates a **new** worker; there is no persistent worker pool or caching/compilation of functions.

Inside the worker:

1. Receive the code and message; construct a function with `new Function` in strict mode, appending a lookup for `parseMessage` first, then `parse`. If neither resolves to a function, throw an error. A function declaration such as `function parseMessage(message) { ... }` is the intended format. The worker accepts `parse` as an implementation fallback even though the prompt asks for `parseMessage`.
2. Invoke and `await` the parser function. Although the generated prompt demands synchronous code, this runner technically accepts a returned Promise.
3. Treat `null`, `undefined`, and `false` as **no match**. Any other non-object or a top-level array is an error. A top-level non-array object is serialized and parsed with JSON to produce a plain transferable value, then sent as `{ matched: true, result }`. An empty object counts as a match; the runner does not validate fields or require a particular schema.
4. Catch execution/serialization errors and post `{ matched: false, error: <message> }`.

On the main thread, message/error/timeout paths all call `finish()` at most once: clear timer, terminate worker, revoke Blob URL, resolve with the worker outcome. The error event and timeout turn into failed matches. A worker that loops indefinitely is stopped when the timeout callback gets a chance to run. Construction/setup errors in the main thread (for example `new Worker` blocked by policy) are **not caught by the worker's inner try/catch** and can reject the returned Promise.

`findMatchingParser(message)` maps the current `parsers` array into concurrent `runParser` calls with `Promise.all`, then picks the first matching outcome **in saved-array order**, not the first worker to finish. With many parsers, this can create many simultaneous workers and waits for *all* results before picking a match. Errors from individual workers are not surfaced in the main parse result; if nothing matches, the UI says the format was not recognized.

**Important security boundary:** a Web Worker is separate from the DOM/main thread and can be terminated, but it is **not a security sandbox for malicious JavaScript**. Saved code is executed with `new Function`; depending on the origin/browser policy, worker code can use worker-side APIs including networking. It can read its supplied message and potentially communicate externally. The prompt's “no network/eval/browser APIs” wording is an instruction to an AI, **not an enforced permission boundary**. Do not accept arbitrary untrusted parser code in a security-sensitive product without a stronger isolation and permission design. A restrictive CSP may also block Blob workers or dynamic evaluation, in which case this implementation needs redesign or compatible policy.

### 5.4 Builder, examples, and prompt (`script.js:230–354`)

`syncExamplesFromFields()` captures current textareas before any rerender so edits survive. `renderExamples(focusLast)` recreates all labeled message fields from the `examples` array, gives each an ID and index label, hides remove buttons when only two remain, updates the count, and disables Add at ten; optionally focuses the last newly created textarea. Adding/removing invokes sync first. `openParserBuilder()` clears examples, name, code, and prompt; rerenders the initial two fields; resets progress to step 1; calls `showModal()`.

On **Create AI prompt** the handler syncs fields, cleans every example, rerenders, finds the first empty example, and uses `setCustomValidity()`/`reportValidity()` to report it and remain on step 1. An input listener clears that custom error after editing. Otherwise it fills the read-only prompt and advances to step 2. A blank additional field must be removed or filled. There is no similarity check, deduplication, minimum text length, or example-size limit.

`buildPrompt(examples)` embeds each normalized input under a numbered `--- EXAMPLE n ---` marker. The substantial template in `script.js:278–329` tells the external AI to:

- output executable JavaScript only, defining a synchronous `function parseMessage(message)` that returns an object or `null`;
- match the same format and purpose as **every** example, and reject unrelated/malformed input using multiple stable signals;
- use stable keys/types and extract only unambiguous values, without hard-coded sample-specific data, guesses, or invented fields;
- keep identifiers, dates, phone/account numbers and formatted monetary values as strings; use `null` for missing/ambiguous expected fields;
- use built-in string methods and **regex literals**, not constructed `RegExp` strings, external dependencies, imports, network, or browser/Node APIs;
- avoid expensive patterns, check punctuation escaping, and mentally trace every example before returning the final function;
- consult a reference function demonstrating the contract rather than the specific target format.

This is **prompt guidance**, not a static validator: the code is only exercised against the positive examples before saving. The sample/reference function in the prompt is illustrative; it does not automatically provide a shipping-message parser.

`showDialogStep(n)` hides all other step sections, marks the chosen progress item active and earlier ones complete, and hides the parser form error. Back buttons only change the visible step; existing draft name/code and previously generated prompt remain unless the dialog is reopened via `openParserBuilder()`.

### 5.5 Clipboard and external links (`script.js:356–395, 451–496`)

`copyText()` tries `navigator.clipboard.writeText`, falls back to a temporary off-screen readonly textarea plus `document.execCommand('copy')`, and briefly changes the button's `<span>` to success or failure text before restoring it after 1.4 seconds. Copy JSON and Copy prompt both use this helper. Clicking either external AI link **starts** an asynchronous prompt copy but does not await it or prevent navigation; there is no automatic paste into the AI site. Clipboard permission or browser restrictions can make that copy fail, so use the explicit Copy prompt button and check its feedback if necessary.

### 5.6 Main parse interaction (`script.js:397–453`)

- Typing updates a displayed UTF-16 string-length character counter via `.value.length.toLocaleString()`; the native main textarea `maxlength` enforces 10,000 input code units. Clicking Use sample sets and focuses its predefined email and updates the counter; it does **not** automatically submit.
- On form submit, default navigation is prevented and the input is normalized; empty cleaned input returns without changing the output. With zero saved parsers, the error view offers **Add a parser** and its action opens the builder.
- Otherwise the submit button is disabled and relabeled, loading is shown, and all parsers are run. A match is `JSON.stringify`-formatted with two-space indentation, assigned with `textContent` (not injected as HTML), labeled with the winning parser's name, and shown in the success view. Otherwise a generic unrecognized-format error appears. The button is re-enabled afterward.
- The error action resets to the empty view and focuses the message input unless the error is the special no-parsers case. Copy appears only for success.

`showState()` toggles the four views with the HTML `hidden` property, relying on `[hidden] { display: none !important; }` in the CSS, and synchronizes the Copy button. `setErrorState()` updates title/message/action without using HTML injection. `setSubmitting()` manages the submit label and disabled state. There is no request cancellation, match history, output persistence, automatic parse on input, or failure-detail display for regular parsing.

### 5.7 Save interaction (`script.js:499–571`)

The user can advance to step 3 without checking whether they really obtained code. On Save:

1. Normalize name and code, write cleaned values back to the fields, hide any earlier form error, and reject an empty name or empty code with an inline message. The name's `reportValidity()` is not relied on as the only validation.
2. Disable Save and show “Testing parser…”. Run the candidate code against **every stored example in parallel**, each with a new worker and the same timeout/return contract used during real parsing. Re-enable Save when all results return.
3. On first failed example (in example-array order), show its execution error if present. Otherwise, if the code seems to combine `new RegExp(...)` with improperly escaped regex tokens in quoted strings, display a targeted escaping hint; otherwise request better matching rules. The regex heuristic only affects the message shown after a failed test; it is not a prohibition on `new RegExp`.
4. If all examples matched, append `{ id, name, code, createdAt }` to `parsers`, write the entire array to `localStorage`, rerender chips/count, and close the dialog.

**What passing tests means:** all provided *positive* examples returned a serializable non-array object within the time limit. It does **not** prove the parser rejects unrelated messages, follows the prompt's API restrictions, extracts the right values, uses consistent fields, or is safe. No negative examples are run. An object may be JSON-converted with data loss (for example unsupported property values); a circular object triggers an error. Save/storage/setup exceptions can leave the operation failed without a friendly UI message.

## 6. Styling and responsive behavior (`styles.css`)

The stylesheet is hand-written CSS, with no CSS framework or preprocessor. It follows the HTML order:

| Lines | Main rules |
| --- | --- |
| 1–45 | Light theme tokens (`--ink`, `--muted`, `--line`, `--surface`, `--background`, green/lime/red accents, mono/sans fonts), universal `border-box`, body background, basic typography, page max width. |
| 47–169 | Header/logo/status/add button and hero type hierarchy. |
| 171–287 | Flexible parser library, wrapping ellipsis-clipped chips, delete controls, add button. |
| 289–450 | Two-column workspace; left/right panels; shared headings; primary input, character count, and submit button. |
| 453–604 | Empty/loading/success/error visuals, rotating spinner, dark formatted JSON card, action styling. |
| 606–629 | Footer, globally enforced `[hidden]`, and `.sr-only` visually hidden but accessible label. |
| 631–770 | Builder modal/backdrop, scrolling shell, heading, three-stage progress bar, step copy. |
| 772–912 | Example textarea cards, remove/add controls, dialog footer, privacy note, primary buttons. |
| 913–1085 | Generated-prompt editor, AI links, form labels, name/code inputs, trust warning and inline errors. |
| 1087–1117 | At widths ≤780 px, workspace becomes one column, library wraps, and the input/output separator changes orientation. |
| 1119–1201 | At widths ≤460 px, header labels and progress labels become visually hidden, dialog padding shrinks, buttons/footer stack, and the submit button fills the available width. |
| 1203–1212 | `prefers-reduced-motion: reduce` greatly shortens animations and transitions. |

The main input has a general `textarea` rule; later, more-specific selectors customize example, prompt, and code textareas. SVG icons are inline in HTML and generally decorative (`aria-hidden` where appropriate). The output card uses `white-space: pre-wrap` for readable multiline JSON. Text and code remain as text nodes or textarea values rather than being parsed as markup.

Accessibility features include native labels/`aria-label`s, a modal `<dialog>`, `aria-live` for output changes, `role="alert"` errors, focus on newly added examples and selected transitions, and reduced-motion support. Porting should also test keyboard navigation and small-screen use rather than assuming these features guarantee full accessibility; for example, narrow-screen header button text is visually suppressed with `font-size: 0` without a dedicated `aria-label` on that button.

## 7. How to reuse this design in another repository

### Direct static copy

1. Copy `index.html`, `styles.css`, and `script.js` together, retaining their relative paths or changing the `<link>`/`<script>` URLs accordingly. Copy this guide separately as documentation if desired.
2. Serve over HTTP(S). Ensure a CSP, if present, permits the fonts as desired, Blob-backed workers, and dynamic function compilation inside them. Rather than broadly relaxing an application's CSP, consider redesigning worker loading and parser execution to meet its security requirements.
3. Keep matching element IDs/data attributes and preserve script load timing, or adapt the DOM queries and initial rendering to the destination app lifecycle.
4. Decide whether `STORAGE_KEY` should change to isolate the new app's stored parsers; changing it makes existing stored parsers invisible unless you implement a migration. If replacing storage with a database or API, preserve the `{ id, name, code, createdAt }` contract or migrate it deliberately.
5. Decide on a trust model **before** accepting parser code. The existing worker/timeout offers responsiveness, not secure multi-tenant execution. If prompts/messages contain confidential data, review both the external AI workflow and worker network permissions.
6. In a framework port, preserve the behavioral boundary: immutable parser records; builder draft examples; generated prompt; per-execution worker result `{ matched, result?, error? }`; result-state transitions; and a single shared normalization policy for training examples and real inputs.

### Important contracts to preserve or consciously change

```text
Input to saved function: normalized message string
Expected match: JSON-serializable, non-array object
Expected no match: null (also undefined/false accepted by runner)
Errors: failed match; surfaced on save tests, generic on ordinary parse
Timeout: 1,500 ms per worker invocation
Selection: first saved matching parser, after all workers finish
Persistence: localStorage array under message-parser-library-v1
```

If changing the matcher to short-circuit sequentially or to pick the fastest worker, the winner can differ for overlapping parsers. If replacing `cleanMessage`, revalidate existing parsers: even innocuous whitespace/Unicode changes can alter matching and extraction. If adding a backend, don't assume that code stored in a browser can safely run on a server.

### Manual verification checklist for a port

- Initial load shows 0 parsers and empty output; main submit with text offers to add a parser; sample only fills the input.
- Builder opens from either Add button with two empty examples; adding reaches at most ten; removal stops at two; blank examples cannot advance.
- Generated prompt contains all normalized, numbered examples; Copy prompt and AI links behave as expected under clipboard permission restrictions.
- Saving blank name/code shows errors; a `parseMessage` returning a JSON object for **all** examples saves; a parser returning `null` for one example does not; a throwing parser reports the failing example.
- Refresh reloads saved chips; deleting confirms and persists; matched input shows the named parser's formatted JSON and enables Copy; unmatched input shows the generic error; a looping parser times out without freezing the page.
- Test at narrow widths, with keyboard navigation and reduced-motion preference. Check both normal browser storage and denied/disabled-storage environments if reliability there matters.

## 8. Known constraints and risks (as implemented)

1. **Trust:** supplied code is arbitrary JavaScript in a worker, not an isolated secure sandbox. The AI prompt and warning are advisory; the timer primarily limits long-running execution.
2. **No automatic AI:** the user must send the prompt to an external AI and paste returned code; prompt copying on link clicks is best-effort, and privacy mode is not verified programmatically.
3. **No built-in parser:** neither the shipping sample nor any other format will match until the user saves a suitable parser.
4. **Limited validation:** save checks only positive examples and object-shaped serialization; it does not test unrelated inputs, schema stability, data accuracy, code safety, or the AI prompt rules.
5. **Storage:** records, including full source code, live only in origin-scoped `localStorage`. Invalid JSON falls back to empty, but malformed entries inside a valid array can still cause runtime problems. Storage writes and worker setup failures lack a graceful recovery path.
6. **Scaling:** every parse starts one worker per saved parser and waits for all; saving starts one worker per example. There is no configured limit on number of saved parsers or persistent worker reuse.
7. **Error reporting:** runtime failures during normal parsing are treated like non-matches. A parser that happens to return `{}` is considered a match even if it extracted nothing; the first saved parser can mask a more specific later one.
8. **Input limits:** 10,000 characters applies to the main textarea only. Example textareas and parser code have no explicit length limit; name input has a 60-character HTML limit before normalization.
9. **No management beyond deletion:** no edit, import/export, sync, versioning, ordering UI, test suite, automated regression tests, or saved parse history.

The fastest way to extend this system safely is to separate the trusted UI/prompt-generation parts from the **untrusted-code execution** decision, then explicitly choose storage, permissions, validation, and error-handling appropriate for the destination repository.
