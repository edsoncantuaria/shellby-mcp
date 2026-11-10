import { isApprovalOrigin, siteKey } from "./policy.js"

const origin = new URLSearchParams(location.search).get("origin") ?? ""

if (!isApprovalOrigin(origin)) window.close()
document.getElementById("origin").textContent = origin

async function decide(decision) {
  await chrome.storage.local.set({ [siteKey(origin)]: decision })
  window.close()
}

document.getElementById("allow").addEventListener("click", () => decide("allow"))
document.getElementById("deny").addEventListener("click", () => decide("deny"))
