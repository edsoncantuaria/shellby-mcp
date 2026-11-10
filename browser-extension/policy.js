// Pure rules shared by the service worker and its tests. No chrome.* access here.

const SENSITIVE_QUERY_NAME = /token|key|secret|auth|sig|session|code|pass/iu
const PAIRING_PATTERN = /^shellby:(\d{1,5}):([a-f0-9]{64})$/u
const LETTER = /^[A-Z]$/u
const DIGIT = /^\d$/u

const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 }
const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
}

/** A blank tab needs no approval, a web page needs its origin approved, and the rest is off limits. */
export function classifyUrl(raw) {
  if (raw === "" || raw === undefined || raw === "about:blank") return { kind: "blank" }
  try {
    const url = new URL(raw)
    if (url.protocol === "http:" || url.protocol === "https:")
      return { kind: "site", origin: url.origin }
  } catch {
    // An unparsable URL is treated like any other non-web page.
  }
  return { kind: "protected" }
}

export function siteKey(origin) {
  return `site:${origin}`
}

export function isApprovalOrigin(value) {
  const verdict = classifyUrl(value)
  return verdict.kind === "site" && verdict.origin === value
}

export function parsePairing(text) {
  const match = PAIRING_PATTERN.exec(text.trim())
  if (!match) return
  const port = Number(match[1])
  if (port < 1 || port > 65_535) return
  return { port, secret: match[2] }
}

/** Keep URLs useful in logs while dropping credentials carried in query strings. */
export function redactUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  url.username = ""
  url.password = ""
  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_NAME.test(name)) url.searchParams.set(name, "REDACTED")
  }
  return url.href
}

export function parseKeyCombo(combo) {
  const parts = combo.split("+")
  const last = parts.length > 1 && parts.at(-1) === "" ? "+" : parts.at(-1)
  let modifiers = 0
  for (const name of parts.slice(0, last === "+" ? -2 : -1)) {
    const bit = MODIFIER_BITS[name.toLowerCase()]
    if (bit === undefined) return
    modifiers |= bit
  }
  const named = NAMED_KEYS[last.toLowerCase()]
  const key = named ?? characterKey(last)
  if (!key) return
  // Chords are shortcuts: they must not also insert their character.
  const inserts = key.text !== undefined && (modifiers & ~MODIFIER_BITS.shift) === 0
  return { ...key, text: inserts ? key.text : undefined, modifiers }
}

function characterKey(character) {
  if ([...character].length !== 1) return
  const upper = character.toUpperCase()
  if (LETTER.test(upper))
    return { key: character, code: `Key${upper}`, vk: upper.charCodeAt(0), text: character }
  if (DIGIT.test(character))
    return {
      key: character,
      code: `Digit${character}`,
      vk: character.charCodeAt(0),
      text: character,
    }
  return { key: character, code: "", vk: 0, text: character }
}

export async function hmacHex(secret, value) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
