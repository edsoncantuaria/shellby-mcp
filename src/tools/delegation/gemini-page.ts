/**
 * Everything Shellby knows about gemini.google.com's DOM. These are source strings rather than
 * functions because a bundler's helpers would not exist inside the page.
 */
const COMPOSER = 'rich-textarea .ql-editor[contenteditable="true"]'
const INPUT_BUTTONS = "input-area-v2 button"
const SEND_LABEL = "/^(enviar|send)\\b/iu"
const STOP_LABEL = "/^(parar|interromper|stop)\\b/iu"
/** Read through textContent: innerText is empty for content Chrome is not painting, as in background tabs. */
const TEXT_BLOCKS = "p, li, pre, h1, h2, h3, h4, h5, h6, tr, blockquote, br"
const SEND_BUTTON_WAIT_TICKS = 30
const SEND_BUTTON_TICK_MS = 100
const SUBMIT_CONFIRM_TICKS = 80
const ATTACHMENT = "input-area-v2 uploader-file-preview"
const UPLOAD_PROGRESS = "input-area-v2 mat-progress-spinner, input-area-v2 [role=progressbar]"
const UPLOAD_WAIT_TICKS = 300
const CONFIRM_LABEL = "/^(permitir|allow)$/iu"

const HELPERS = `
  const composer = () => document.querySelector(${JSON.stringify(COMPOSER)});
  const inputButton = (label) => [...document.querySelectorAll(${JSON.stringify(INPUT_BUTTONS)})]
    .find((button) => label.test(button.getAttribute("aria-label") ?? ""));
  const hasDraft = (editor) => editor.textContent.trim().length > 0;
  const readable = (root) => {
    if (!root) return "";
    const copy = root.cloneNode(true);
    copy.querySelectorAll(".cdk-visually-hidden").forEach((node) => node.remove());
    copy.querySelectorAll(${JSON.stringify(TEXT_BLOCKS)}).forEach((node) => node.append("\\n"));
    return copy.textContent.replace(/\\n\\s*\\n\\s*\\n/gu, "\\n\\n").trim();
  };
`

export interface GeminiPageSnapshot {
  ready: boolean
  draft: boolean
  generating: boolean
  /** A tool permission prompt is waiting for the user. */
  confirming: boolean
  /** Submitted prompts rendered in the conversation. */
  users: number
  /** Responses rendered in the conversation, including one still streaming. */
  models: number
  /** The newest response's text. */
  text: string
  url: string
}

export type GeminiSendOutcome =
  | "sent"
  | "busy"
  | "draft"
  | "no-composer"
  | "no-send-button"
  | "not-submitted"

export interface GeminiTranscriptEntry {
  role: "user" | "model"
  text: string
}

export const GEMINI_SNAPSHOT_SCRIPT = `(() => {
  ${HELPERS}
  const editor = composer();
  const responses = [...document.querySelectorAll("model-response")];
  const newest = responses.at(-1)?.querySelector("message-content");
  return {
    ready: Boolean(editor),
    draft: editor ? hasDraft(editor) : false,
    generating: Boolean(inputButton(${STOP_LABEL})),
    confirming: [...(responses.at(-1)?.querySelectorAll("button") ?? [])]
      .some((button) => ${CONFIRM_LABEL}.test(button.textContent.trim())),
    users: document.querySelectorAll("user-query").length,
    models: responses.length,
    text: readable(newest),
    url: location.href,
  };
})()`

export const GEMINI_TRANSCRIPT_SCRIPT = `(() => {
  ${HELPERS}
  return [...document.querySelectorAll("user-query, model-response")].map((node) => ({
    role: node.matches("user-query") ? "user" : "model",
    text: readable(node.querySelector("message-content") ?? node),
  }));
})()`

/**
 * Never replaces a draft or interrupts a response; both are reported instead. "sent" means Gemini
 * accepted the message, and an ignored click leaves the composer empty for a retry.
 */
export function geminiSendScript(message: string): string {
  return `(async (message) => {
  ${HELPERS}
  const editor = composer();
  if (!editor) return "no-composer";
  if (inputButton(${STOP_LABEL})) return "busy";
  if (hasDraft(editor)) return "draft";
  editor.focus();
  document.execCommand("insertText", false, message);
  for (let tick = 0; tick < ${SEND_BUTTON_WAIT_TICKS}; tick += 1) {
    const send = inputButton(${SEND_LABEL});
    if (send && !send.disabled && send.getAttribute("aria-disabled") !== "true") {
      const submittedBefore = document.querySelectorAll("user-query").length;
      send.click();
      for (let wait = 0; wait < ${SUBMIT_CONFIRM_TICKS}; wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, ${SEND_BUTTON_TICK_MS}));
        if (document.querySelectorAll("user-query").length > submittedBefore || !hasDraft(editor))
          return "sent";
      }
      editor.focus();
      document.execCommand("selectAll");
      document.execCommand("delete");
      return "not-submitted";
    }
    await new Promise((resolve) => setTimeout(resolve, ${SEND_BUTTON_TICK_MS}));
  }
  return "no-send-button";
})(${JSON.stringify(message)})`
}

export type GeminiAttachOutcome = "attached" | "draft" | "no-composer" | "upload-failed"

/** Pasted like a clipboard image, which needs no file picker and works in a background tab. */
export function geminiAttachImageScript(
  base64: string,
  mimeType: string,
  fileName: string
): string {
  return `(async (data, type, name) => {
  ${HELPERS}
  const editor = composer();
  if (!editor) return "no-composer";
  if (hasDraft(editor) || document.querySelector(${JSON.stringify(ATTACHMENT)})) return "draft";
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  const clipboard = new DataTransfer();
  clipboard.items.add(new File([bytes], name, { type }));
  editor.focus();
  editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  for (let tick = 0; tick < ${UPLOAD_WAIT_TICKS}; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, ${SEND_BUTTON_TICK_MS}));
    if (document.querySelector(${JSON.stringify(ATTACHMENT)}) && !document.querySelector(${JSON.stringify(UPLOAD_PROGRESS)}))
      return "attached";
  }
  return "upload-failed";
})(${JSON.stringify(base64)}, ${JSON.stringify(mimeType)}, ${JSON.stringify(fileName)})`
}

export function isGeminiUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "gemini.google.com"
  } catch {
    return false
  }
}

const CONVERSATION_PATH = /^\/(?:u\/\d+\/)?app\/[0-9a-z]+\/?$/iu

/** A saved chat, as opposed to the new-chat page at `/app`. */
export function isGeminiConversationUrl(value: string): boolean {
  return isGeminiUrl(value) && CONVERSATION_PATH.test(new URL(value).pathname)
}
