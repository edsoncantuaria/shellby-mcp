import { join } from "node:path"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { MCP_CONFIG } from "../config.js"
import { ShellbyAuthStore } from "./store.js"

const auth = new ShellbyAuthStore(join(MCP_CONFIG.stateDir, "auth.json"))
const input = createInterface({ input: process.stdin, output: process.stdout })

console.warn(
  [
    "WARNING: adding a Shellby MCP account slot will:",
    "- keep every ChatGPT identity that is already bound",
    "- let ONE more ChatGPT user bind on its next tool call",
    "- give that user full access to this machine through Shellby MCP",
  ].join("\n")
)

try {
  const answer = (await input.question("Allow one more ChatGPT account? [y/N] "))
    .trim()
    .toLowerCase()
  if (answer !== "y" && answer !== "yes") {
    console.log("Authentication unchanged.")
  } else {
    const state = await auth.openSlot()
    console.log(
      `Shellby MCP now has ${state.subjects.length} bound account(s) and ${state.openSlots} open slot(s).`
    )
  }
} finally {
  input.close()
}
