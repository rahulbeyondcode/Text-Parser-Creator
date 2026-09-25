const STORAGE_KEY = "message-parser-library-v1";
const MIN_EXAMPLES = 2;
const MAX_EXAMPLES = 10;
const PARSER_TIMEOUT_MS = 1500;

const form = document.querySelector("#parser-form");
const messageInput = document.querySelector("#message-input");
const characterCount = document.querySelector("#character-count");
const submitButton = document.querySelector("#submit-button");
const sampleButton = document.querySelector("#sample-button");
const copyButton = document.querySelector("#copy-button");
const jsonOutput = document.querySelector("#json-output");
const matchedParserLabel = document.querySelector("#matched-parser-label");
const errorTitle = document.querySelector("#error-title");
const errorMessage = document.querySelector("#error-message");
const errorActionButton = document.querySelector("#error-action-button");
const parserCount = document.querySelector("#parser-count");
const parserChips = document.querySelector("#parser-chips");
const libraryDescription = document.querySelector("#library-description");

const parserDialog = document.querySelector("#parser-dialog");
const examplesList = document.querySelector("#examples-list");
const exampleCount = document.querySelector("#example-count");
const addExampleButton = document.querySelector("#add-example");
const generatedPrompt = document.querySelector("#generated-prompt");
const parserNameInput = document.querySelector("#parser-name");
const parserCodeInput = document.querySelector("#parser-code");
const parserFormError = document.querySelector("#parser-form-error");
const saveParserButton = document.querySelector("#save-parser");

const states = {
  empty: document.querySelector("#empty-state"),
  loading: document.querySelector("#loading-state"),
  success: document.querySelector("#success-state"),
  error: document.querySelector("#error-state"),
};

const sampleMessage = `From: orders@northstar.example
Subject: Your order has shipped

Hi Alex,

Good news — order #NS-20481 is on its way.
Carrier: Express Parcel
Tracking number: EP839201475
Estimated delivery: Friday, September 25

Thanks,
Northstar Supply`;

let parsers = loadParsers();
let examples = ["", ""];
let errorAction = "retry";

function loadParsers() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function persistParsers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(parsers));
}

function showState(stateName) {
  Object.entries(states).forEach(([name, element]) => {
    element.hidden = name !== stateName;
  });
  copyButton.hidden = stateName !== "success";
}

function setErrorState(title, message, actionLabel = "Try again", action = "retry") {
  errorTitle.textContent = title;
  errorMessage.textContent = message;
  errorActionButton.textContent = actionLabel;
  errorAction = action;
  showState("error");
}

function updateCharacterCount() {
  characterCount.textContent = `${messageInput.value.length.toLocaleString()} / 10,000`;
}

function setSubmitting(isSubmitting) {
  submitButton.disabled = isSubmitting;
  submitButton.querySelector("span").textContent = isSubmitting
    ? "Checking parsers…"
    : "Parse message";
}

function renderParserLibrary() {
  parserChips.replaceChildren();

  parsers.forEach((parser) => {
    const chip = document.createElement("div");
    chip.className = "parser-chip";

    const name = document.createElement("span");
    name.textContent = parser.name;
    name.title = parser.name;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "×";
    removeButton.setAttribute("aria-label", `Delete ${parser.name}`);
    removeButton.addEventListener("click", () => deleteParser(parser.id));

    chip.append(name, removeButton);
    parserChips.append(chip);
  });

  const count = parsers.length;
  parserCount.textContent = `${count} ${count === 1 ? "parser" : "parsers"}`;
  libraryDescription.textContent = count
    ? `${count} saved locally in this browser.`
    : "Add a parser to start recognizing messages.";
}

function deleteParser(parserId) {
  const parser = parsers.find((item) => item.id === parserId);
  if (!parser || !window.confirm(`Delete “${parser.name}”?`)) return;

  parsers = parsers.filter((item) => item.id !== parserId);
  persistParsers();
  renderParserLibrary();
}

function cleanMessage(message) {
  return String(message ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/^\n+|\n+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s\uFFFD]+|[\s\uFFFD]+$/gu, "");
}

function cleanParserName(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanParserCode(code) {
  return String(code ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .trim()
    .replace(/^```(?:javascript|js)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function runParser(parser, message) {
  return new Promise((resolve) => {
    const workerSource = `
      self.onmessage = async function (event) {
        try {
          const source = event.data.code;
          const factory = new Function(
            '"use strict";\\n' + source +
            '\\n;if (typeof parseMessage === "function") return parseMessage;' +
            '\\nif (typeof parse === "function") return parse;' +
            '\\nthrow new Error("Code must define parseMessage(message) or parse(message).");'
          );
          const parserFunction = factory();
          const result = await parserFunction(event.data.message);

          if (result === null || result === undefined || result === false) {
            self.postMessage({ matched: false });
            return;
          }

          if (typeof result !== "object" || Array.isArray(result)) {
            throw new Error("A matched message must return a JSON object.");
          }

          const safeResult = JSON.parse(JSON.stringify(result));
          self.postMessage({ matched: true, result: safeResult });
        } catch (error) {
          self.postMessage({ matched: false, error: error.message || String(error) });
        }
      };
    `;

    const blobUrl = URL.createObjectURL(
      new Blob([workerSource], { type: "text/javascript" }),
    );
    const worker = new Worker(blobUrl);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      resolve(result);
    };

    const timeoutId = window.setTimeout(() => {
      finish({ matched: false, error: "Parser timed out." });
    }, PARSER_TIMEOUT_MS);

    worker.addEventListener("message", (event) => finish(event.data));
    worker.addEventListener("error", (event) => {
      finish({ matched: false, error: event.message || "Parser could not run." });
    });
    worker.postMessage({ code: parser.code, message: cleanMessage(message) });
  });
}

async function findMatchingParser(message) {
  const results = await Promise.all(
    parsers.map(async (parser) => ({ parser, outcome: await runParser(parser, message) })),
  );
  return results.find(({ outcome }) => outcome.matched) || null;
}

function syncExamplesFromFields() {
  examples = [...examplesList.querySelectorAll("textarea")].map((field) => field.value);
}

function renderExamples(focusLast = false) {
  examplesList.replaceChildren();

  examples.forEach((value, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "example-field";

    const label = document.createElement("label");
    label.htmlFor = `example-${index}`;
    label.textContent = `MESSAGE ${String(index + 1).padStart(2, "0")}`;

    const textarea = document.createElement("textarea");
    textarea.id = `example-${index}`;
    textarea.value = value;
    textarea.required = true;
    textarea.placeholder = "Paste a complete SMS or message here…";

    const removeButton = document.createElement("button");
    removeButton.className = "remove-example";
    removeButton.type = "button";
    removeButton.textContent = "×";
    removeButton.hidden = examples.length <= MIN_EXAMPLES;
    removeButton.setAttribute("aria-label", `Remove message ${index + 1}`);
    removeButton.addEventListener("click", () => {
      syncExamplesFromFields();
      examples.splice(index, 1);
      renderExamples();
    });

    wrapper.append(label, textarea, removeButton);
    examplesList.append(wrapper);
  });

  exampleCount.textContent = `${examples.length} of ${MAX_EXAMPLES} messages`;
  addExampleButton.disabled = examples.length >= MAX_EXAMPLES;

  if (focusLast) examplesList.querySelector("textarea:last-of-type")?.focus();
}

function buildPrompt(messageExamples) {
  const formattedExamples = messageExamples
    .map((message, index) => `--- EXAMPLE ${index + 1} ---\n${cleanMessage(message)}`)
    .join("\n\n");

  return `Create a JavaScript message parser based on the examples below.

A parser is a function that examines one raw SMS, email, or message and does one of two things:
- If the message matches the same format and purpose as these examples, return a plain JSON-serializable object containing the useful fields found in that message.
- If it does not match, return null. Do not guess and do not return partial results for unrelated messages.

NON-NEGOTIABLE RESULT
The final parseMessage function must return a non-null object for EVERY supplied example. It must return null for messages outside that format. Do not output code until you have checked the function against the exact text of every example below.

OUTPUT CONTRACT
1. Return only executable JavaScript source—no Markdown fences, explanation, tests, usage examples, or surrounding text.
2. Define exactly one synchronous entry function: function parseMessage(message) { ... }
3. It must return one plain JSON-serializable object for a match, or null for no match.
4. Use only built-in JavaScript string methods and regex literals. No imports, external libraries, network calls, eval, browser APIs, or Node.js APIs.

MATCHING AND EXTRACTION
5. Return null for non-string, empty, malformed, or unrelated input. Do not throw for ordinary input.
6. Recognize the format using at least two stable signals, such as a distinctive phrase plus labeled structure. Never identify it using one common word or a sample-specific value.
7. Values that differ between examples are variable. Never hard-code sample names, amounts, dates, IDs, account suffixes, phone numbers, merchants, or links.
8. Use the same object keys and value types for every matching example. Every key must keep exactly the same meaning.
9. Extract only values whose meaning is unambiguous from a label or stable position. Never infer, calculate, correct, complete, or invent a value.
10. Use null for an expected but missing or ambiguous field. Never return undefined, NaN, Infinity, guessed defaults, or placeholder strings.
11. Preserve identifiers, dates, times, phone numbers, account numbers, and formatted monetary values as trimmed strings. This prevents loss of leading zeros, separators, and precision.
12. Prefer fewer reliable fields over speculative fields. Do not return parser metadata, debug data, regex matches, confidence scores, or the original message.

REGEX RULES—FOLLOW THESE EXACTLY
13. Use regex literals only, for example /\\s+/i. Do not use new RegExp(), quoted regex fragments, or dynamically assembled patterns anywhere in the answer.
14. Prefer several small, readable extraction regexes over one large expression. Require every essential extraction to succeed before returning an object.
15. Escape punctuation that appears literally in a message. For example, the text "Not you?" requires an escaped question mark: /Not\\s+you\\s*\\?/. Remember that ?, ., +, *, parentheses, brackets, and currency symbols can have special regex meanings.
16. Accept harmless capitalization, spacing, and line-ending differences without making distinctive words or labels optional.
17. Avoid unbounded wildcards and catastrophic backtracking. The parser must finish quickly for long unrelated input.

FINAL CHECK BEFORE ANSWERING
- Trace the exact first example through every condition and regex. Each required match must succeed.
- Check every remaining example and confirm parseMessage returns a non-null object with the same schema.
- Check that extracted values do not include their labels, trailing punctuation, or neighboring text.
- Check that clearly unrelated text returns null.
- Check the final answer again for forbidden new RegExp() usage and unescaped literal punctuation.
- Output only the final parseMessage function after all checks pass.

REFERENCE ONLY — this illustrates the contract, not the format you should parse:
function parseMessage(message) {
  if (!message.includes("Stable sender text")) return null;
  const idMatch = message.match(/Reference:\\s*([A-Z0-9-]+)/i);
  return {
    messageType: "exampleNotification",
    referenceId: idMatch ? idMatch[1] : null
  };
}

MESSAGES TO ANALYZE
${formattedExamples}`;
}

function showDialogStep(stepNumber) {
  document.querySelectorAll(".dialog-step").forEach((step) => {
    step.hidden = Number(step.dataset.step) !== stepNumber;
  });

  document.querySelectorAll(".progress-item").forEach((item) => {
    const itemStep = Number(item.dataset.progress);
    item.classList.toggle("is-active", itemStep === stepNumber);
    item.classList.toggle("is-complete", itemStep < stepNumber);
  });

  parserFormError.hidden = true;
}

function openParserBuilder() {
  examples = ["", ""];
  parserNameInput.value = "";
  parserCodeInput.value = "";
  generatedPrompt.value = "";
  renderExamples();
  showDialogStep(1);
  parserDialog.showModal();
}

function fallbackCopyText(text) {
  try {
    const temporaryField = document.createElement("textarea");
    temporaryField.value = text;
    temporaryField.setAttribute("readonly", "");
    temporaryField.style.position = "fixed";
    temporaryField.style.opacity = "0";
    temporaryField.style.pointerEvents = "none";
    document.body.append(temporaryField);
    temporaryField.select();
    const copied = document.execCommand("copy");
    temporaryField.remove();
    return copied;
  } catch {
    return false;
  }
}

async function copyText(text, button, successText) {
  const label = button.querySelector("span");
  const originalText = label?.textContent;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else if (!fallbackCopyText(text)) {
      throw new Error("Clipboard is unavailable.");
    }
    if (label) label.textContent = successText;
    window.setTimeout(() => {
      if (label) label.textContent = originalText;
    }, 1400);
  } catch {
    const copied = fallbackCopyText(text);
    if (label) label.textContent = copied ? successText : "Copy failed";
    window.setTimeout(() => {
      if (label) label.textContent = originalText;
    }, 1400);
  }
}

messageInput.addEventListener("input", updateCharacterCount);

sampleButton.addEventListener("click", () => {
  messageInput.value = sampleMessage;
  updateCharacterCount();
  messageInput.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = cleanMessage(messageInput.value);
  if (!message) return;

  messageInput.value = message;
  updateCharacterCount();

  if (!parsers.length) {
    setErrorState(
      "No parsers available",
      "Create at least one parser before checking a message.",
      "Add a parser",
      "add",
    );
    return;
  }

  setSubmitting(true);
  showState("loading");

  const match = await findMatchingParser(message);

  if (match) {
    jsonOutput.textContent = JSON.stringify(match.outcome.result, null, 2);
    matchedParserLabel.textContent = match.parser.name;
    showState("success");
  } else {
    setErrorState(
      "Message format not recognized",
      "This message is not in a format recognized by any of your saved parsers.",
    );
  }

  setSubmitting(false);
});

errorActionButton.addEventListener("click", () => {
  if (errorAction === "add") {
    openParserBuilder();
    return;
  }
  showState("empty");
  messageInput.focus();
});

copyButton.addEventListener("click", () => {
  copyText(jsonOutput.textContent, copyButton, "Copied");
});

document.querySelector("#header-add-parser").addEventListener("click", openParserBuilder);
document.querySelector("#library-add-parser").addEventListener("click", openParserBuilder);
document.querySelector("#close-dialog").addEventListener("click", () => parserDialog.close());

parserDialog.addEventListener("click", (event) => {
  if (event.target === parserDialog) parserDialog.close();
});

addExampleButton.addEventListener("click", () => {
  syncExamplesFromFields();
  if (examples.length >= MAX_EXAMPLES) return;
  examples.push("");
  renderExamples(true);
});

document.querySelector("#generate-prompt").addEventListener("click", () => {
  syncExamplesFromFields();
  examples = examples.map(cleanMessage);
  renderExamples();
  const emptyFieldIndex = examples.findIndex((example) => !example);

  if (emptyFieldIndex !== -1) {
    const field = document.querySelector(`#example-${emptyFieldIndex}`);
    field.setCustomValidity("Paste a message into this field or remove it.");
    field.reportValidity();
    field.addEventListener("input", () => field.setCustomValidity(""), { once: true });
    return;
  }

  generatedPrompt.value = buildPrompt(examples);
  showDialogStep(2);
});

document.querySelector("#copy-prompt").addEventListener("click", (event) => {
  copyText(generatedPrompt.value, event.currentTarget, "Prompt copied");
});

document.querySelectorAll("#open-chatgpt, #open-claude").forEach((link) => {
  link.addEventListener("click", () => {
    const copyPromptButton = document.querySelector("#copy-prompt");
    void copyText(generatedPrompt.value, copyPromptButton, "Prompt copied");
  });
});

document.querySelector("#continue-to-code").addEventListener("click", () => {
  showDialogStep(3);
  parserNameInput.focus();
});

document.querySelectorAll("[data-back]").forEach((button) => {
  button.addEventListener("click", () => showDialogStep(Number(button.dataset.back)));
});

saveParserButton.addEventListener("click", async () => {
  const name = cleanParserName(parserNameInput.value);
  const code = cleanParserCode(parserCodeInput.value);
  parserFormError.hidden = true;

  parserNameInput.value = name;
  parserCodeInput.value = code;

  if (!name) {
    parserNameInput.focus();
    parserNameInput.reportValidity();
    parserFormError.textContent = "Give this parser a name before saving.";
    parserFormError.hidden = false;
    return;
  }

  if (!code) {
    parserCodeInput.focus();
    parserFormError.textContent = "Paste the JavaScript parser code before saving.";
    parserFormError.hidden = false;
    return;
  }

  saveParserButton.disabled = true;
  const saveButtonLabel = saveParserButton.querySelector("span");
  saveButtonLabel.textContent = "Testing parser…";

  const testResults = await Promise.all(
    examples.map((example) => runParser({ code }, example)),
  );

  saveParserButton.disabled = false;
  saveButtonLabel.textContent = "Save parser";

  const failedExampleIndex = testResults.findIndex((result) => !result.matched);
  if (failedExampleIndex !== -1) {
    const failedResult = testResults[failedExampleIndex];
    const usesConstructedRegex = /new\s+RegExp\s*\(/.test(code);
    const likelyStringEscapeIssue = usesConstructedRegex && /["'`]([^"'`\\]|\\.)*\\[sSdDwWbB.][^"'`]*["'`]/.test(code);

    if (failedResult.error) {
      parserFormError.textContent = `Message ${failedExampleIndex + 1} failed: ${failedResult.error}`;
    } else if (likelyStringEscapeIssue) {
      parserFormError.textContent = `The parser did not recognize message ${failedExampleIndex + 1}. It appears to use regex tokens such as \\s or \\d inside new RegExp() strings without double backslashes. Ask the AI to use regex literals or correct the string escaping.`;
    } else {
      parserFormError.textContent = `The parser did not recognize message ${failedExampleIndex + 1}. Ask the AI to test the function against that exact message and correct its matching rules.`;
    }
    parserFormError.hidden = false;
    return;
  }

  parsers.push({
    id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now()),
    name,
    code,
    createdAt: new Date().toISOString(),
  });
  persistParsers();
  renderParserLibrary();
  parserDialog.close();
});

renderParserLibrary();
renderExamples();
