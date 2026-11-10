import { parsePairing } from "./policy.js"

const SITE_PREFIX = "site:"

async function render() {
  const { status = "disconnected" } = await chrome.storage.session.get("status")
  const stored = await chrome.storage.local.get(null)
  document.getElementById("status").textContent = status
  document.getElementById("pause").textContent = stored.paused ? "Resume" : "Pause"
  const nameField = document.getElementById("browser-name")
  if (document.activeElement !== nameField) nameField.value = stored.browserName ?? ""

  const sites = Object.entries(stored).filter(([key]) => key.startsWith(SITE_PREFIX))
  const list = document.getElementById("sites")
  list.replaceChildren(
    ...sites.map(([key, decision]) => {
      const item = document.createElement("li")
      item.textContent = `${key.slice(SITE_PREFIX.length)} (${decision}) `
      const remove = document.createElement("button")
      remove.type = "button"
      remove.textContent = "Forget"
      remove.addEventListener("click", () => chrome.storage.local.remove(key))
      item.append(remove)
      return item
    })
  )
}

document.getElementById("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const field = document.getElementById("pairing")
  const pairing = parsePairing(field.value)
  document.getElementById("pair-error").textContent = pairing ? "" : "That code is not valid."
  if (!pairing) return
  field.value = ""
  await chrome.storage.local.set({ pairing })
})

document.getElementById("browser-name").addEventListener("change", (event) => {
  chrome.storage.local.set({ browserName: event.target.value.trim() })
})

document.getElementById("pause").addEventListener("click", async () => {
  const { paused } = await chrome.storage.local.get("paused")
  await chrome.storage.local.set({ paused: !paused })
})

chrome.storage.onChanged.addListener(() => {
  render()
})
render()
