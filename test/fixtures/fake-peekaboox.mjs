import { appendFileSync } from "node:fs"
import process from "node:process"
import sharp from "sharp"

const [logPath, ...args] = process.argv.slice(2)
if (!logPath) process.exit(0) // Node's --test discovery also runs fixture files directly.
appendFileSync(logPath, `${JSON.stringify(args)}\n`)
const command = args[3]
if (command === "capture") {
  const output = args[args.indexOf("--output") + 1]
  await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
    .png()
    .toFile(output)
  console.log(JSON.stringify({ output_path: output, backend_name: "portal", width: 1, height: 1 }))
} else if (command === "type" && !args.includes("--dry-run")) {
  console.error("no Wayland text backend; install wtype")
  process.exitCode = 1
} else if (command === "windows") {
  console.log(JSON.stringify({ windows: [{ id: "atspi:1", title: "Fixture" }] }))
} else {
  console.log(JSON.stringify({ command, dry_run: args.includes("--dry-run") }))
}
