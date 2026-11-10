// Each export is serialized with toString() and run inside the tab's isolated world, where the page
// cannot read or replace the ref table. They must stay self-contained: no imports, no shared helpers.

export function snapshotPage({ interactiveOnly, query, maxChars, refPrefix }) {
  globalThis.__shellbyRefs ??= { next: 1, byElement: new WeakMap(), byRef: new Map() }
  const refs = globalThis.__shellbyRefs
  const INTERACTIVE = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
  ])
  const NAMED_BY_CONTENT = new Set([...INTERACTIVE, "heading"])
  const SKIPPED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"])
  const TAG_ROLES = {
    ARTICLE: "article",
    ASIDE: "complementary",
    BUTTON: "button",
    DIALOG: "dialog",
    FOOTER: "contentinfo",
    FORM: "form",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    HEADER: "banner",
    IFRAME: "iframe",
    IMG: "img",
    MAIN: "main",
    NAV: "navigation",
    OPTION: "option",
    SELECT: "combobox",
    SUMMARY: "button",
    TABLE: "table",
    TEXTAREA: "textbox",
  }
  const INPUT_ROLES = {
    button: "button",
    checkbox: "checkbox",
    file: "button",
    number: "spinbutton",
    radio: "radio",
    range: "slider",
    reset: "button",
    search: "searchbox",
    submit: "button",
  }
  const SECRET_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/iu
  const SECRET_NAME = /card.?num|cvv|cvc|ssn|password/iu
  const isSecret = (el) =>
    (el.tagName === "INPUT" && el.type === "password") ||
    SECRET_AUTOCOMPLETE.test(el.getAttribute("autocomplete") ?? "") ||
    SECRET_NAME.test(`${el.name ?? ""} ${el.id ?? ""}`)
  const clean = (text, limit) => (text ?? "").replace(/\s+/gu, " ").trim().slice(0, limit)
  const roleOf = (el) => {
    const explicit = el.getAttribute("role")
    if (explicit) return explicit.split(/\s+/u)[0].toLowerCase()
    if (el.tagName === "A") return el.hasAttribute("href") ? "link" : undefined
    if (el.tagName === "INPUT") {
      if (el.type === "hidden") return
      return INPUT_ROLES[el.type] ?? "textbox"
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return "textbox"
    return TAG_ROLES[el.tagName]
  }
  const nameOf = (el, role) => {
    const labelledBy = el.getAttribute("aria-labelledby")
    const referenced = labelledBy
      ?.split(/\s+/u)
      .map((id) => el.getRootNode().getElementById?.(id)?.textContent ?? "")
      .join(" ")
    return clean(
      el.getAttribute("aria-label") ||
        referenced ||
        el.labels?.[0]?.textContent ||
        el.getAttribute("alt") ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        (NAMED_BY_CONTENT.has(role) ? el.textContent : "") ||
        (el.type === "submit" || el.type === "button" ? el.value : ""),
      120
    )
  }
  const refOf = (el) => {
    let ref = refs.byElement.get(el)
    if (!ref) {
      ref = `ref_${refPrefix}${refs.next++}`
      refs.byElement.set(el, ref)
      refs.byRef.set(ref, new WeakRef(el))
    }
    return ref
  }
  const stateOf = (el) => {
    const parts = []
    if (el.tagName === "A" && el.href) parts.push(`href=${JSON.stringify(el.href.slice(0, 200))}`)
    if (/^H[1-6]$/u.test(el.tagName)) parts.push(`level=${el.tagName[1]}`)
    if (el.checked) parts.push("checked")
    if (el.disabled) parts.push("disabled")
    if (el.required) parts.push("required")
    if (el.getAttribute("aria-expanded")) parts.push(`expanded=${el.getAttribute("aria-expanded")}`)
    if (el.selected) parts.push("selected")
    if (el.value && typeof el.value === "string" && !isSecret(el) && el.tagName !== "BUTTON")
      parts.push(`value=${JSON.stringify(clean(el.value, 120))}`)
    if (isSecret(el)) parts.push("secret")
    if (el.type === "file") parts.push("file-input")
    return parts.length > 0 ? ` ${parts.join(" ")}` : ""
  }

  const needle = query?.toLowerCase()
  const lines = []
  let used = 0
  let truncated = false
  let budget = 30_000
  const emit = (line) => {
    if (needle && !line.toLowerCase().includes(needle)) return
    if (used + line.length + 1 > maxChars) {
      truncated = true
      return
    }
    used += line.length + 1
    lines.push(line)
  }
  const visit = (node, depth) => {
    if (truncated || depth > 60) return
    if (budget-- <= 0) {
      truncated = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = clean(node.nodeValue, 300)
      if (text && !interactiveOnly) emit(`${"  ".repeat(depth)}- text ${JSON.stringify(text)}`)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE || SKIPPED.has(node.tagName)) return
    const style = getComputedStyle(node)
    const hidden =
      style.display === "none" ||
      style.visibility === "hidden" ||
      node.getAttribute("aria-hidden") === "true"
    // Styled upload buttons usually hide the real input, which is still the upload target.
    if (hidden && !(node.tagName === "INPUT" && node.type === "file")) return
    const role = roleOf(node)
    let childDepth = depth
    if (role && (!interactiveOnly || INTERACTIVE.has(role))) {
      const name = nameOf(node, role)
      const label = name ? ` ${JSON.stringify(name)}` : ""
      emit(`${"  ".repeat(depth)}- ${role}${label} [${refOf(node)}]${stateOf(node)}`)
      childDepth = depth + 1
      if (NAMED_BY_CONTENT.has(role) && role !== "listbox" && role !== "combobox") return
    }
    let children = node.shadowRoot?.childNodes ?? node.childNodes
    if (node.tagName === "SLOT" && node.assignedNodes().length > 0) children = node.assignedNodes()
    for (const child of children) visit(child, childDepth)
  }
  if (document.body) visit(document.body, 0)
  return { url: location.href, title: document.title, tree: lines.join("\n"), truncated }
}

export function pageText({ maxChars }) {
  const text = document.body?.innerText ?? ""
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  }
}

export function locateRef(ref) {
  const el = globalThis.__shellbyRefs?.byRef.get(ref)?.deref()
  if (!el?.isConnected) return { stale: true }
  let rect = el.getBoundingClientRect()
  // Leave visible elements alone so a drag's two endpoints do not move each other.
  if (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
    rect = el.getBoundingClientRect()
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

export function scrollAt({ x, y, left, top }) {
  const options = { left, top, behavior: "instant" }
  let el = document.elementFromPoint(x ?? window.innerWidth / 2, y ?? window.innerHeight / 2)
  while (el) {
    const style = getComputedStyle(el)
    const scrollable = /auto|scroll/u.test(top ? style.overflowY : style.overflowX)
    const hasRoom = top ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth
    if (scrollable && hasRoom) return el.scrollBy(options)
    el = el.parentElement
  }
  return window.scrollBy(options)
}

export function focusRef(ref) {
  const el = globalThis.__shellbyRefs?.byRef.get(ref)?.deref()
  if (!el?.isConnected) return { stale: true }
  el.focus()
  return {}
}

/** True when the element holding focus would receive a credential or payment value. */
export function focusIsSecret() {
  let el = document.activeElement
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
  if (!el) return false
  return (
    (el.tagName === "INPUT" && el.type === "password") ||
    /^(cc-|current-password|new-password|one-time-code)/iu.test(
      el.getAttribute("autocomplete") ?? ""
    ) ||
    /card.?num|cvv|cvc|ssn|password/iu.test(`${el.name ?? ""} ${el.id ?? ""}`)
  )
}

export function fillRef(ref, value) {
  const el = globalThis.__shellbyRefs?.byRef.get(ref)?.deref()
  if (!el?.isConnected) return { stale: true }
  const secret =
    (el.tagName === "INPUT" && el.type === "password") ||
    /^(cc-|current-password|new-password|one-time-code)/iu.test(
      el.getAttribute("autocomplete") ?? ""
    ) ||
    /card.?num|cvv|cvc|ssn|password/iu.test(`${el.name ?? ""} ${el.id ?? ""}`)
  if (secret) return { secret: true }
  if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return { unsupported: el.tagName }

  if (el.tagName === "SELECT") {
    const option = [...el.options].find((item) => item.value === value || item.text === value)
    if (!option) return { noOption: true }
    el.value = option.value
  } else if (el.type === "checkbox" || el.type === "radio") {
    el.checked = value === "true" || value === "on"
  } else {
    // The prototype setter keeps framework value trackers aware that the value changed.
    const prototype = el.tagName === "INPUT" ? HTMLInputElement : HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(prototype.prototype, "value").set.call(el, value)
  }
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return {}
}

export function attachFiles(ref, files) {
  let el
  if (ref) {
    el = globalThis.__shellbyRefs?.byRef.get(ref)?.deref()
    if (!el?.isConnected) return { stale: true }
  } else {
    const inputs = document.querySelectorAll('input[type="file"]')
    if (inputs.length !== 1) return { inputCount: inputs.length }
    el = inputs[0]
  }
  if (el.tagName !== "INPUT" || el.type !== "file") return { notFileInput: true }
  if (files.length > 1 && !el.multiple) return { singleOnly: true }
  const transfer = new DataTransfer()
  for (const { name, type, data } of files) {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    transfer.items.add(new File([bytes], name, { type }))
  }
  el.files = transfer.files
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return {}
}

export function viewportSize() {
  return { width: innerWidth, height: innerHeight }
}
