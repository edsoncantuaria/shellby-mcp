import type { McpServer } from "@modelcontextprotocol/server"

export const SCREEN_VIEWER_URI = "ui://shellby/screen-viewer.html"
/** Result metadata reaches the viewer but not the model, which keeps the image out of its context. */
export const SCREEN_IMAGE_META_KEY = "shellby/image"

const VIEWER_MIME_TYPE = "text/html+skybridge"
const VIEWER_HTML = `<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;background:transparent}img{display:block;width:100%;height:auto}</style>
<img id="screen" alt="Screenshot">
<script>
function render() {
  const image = window.openai && window.openai.toolResponseMetadata
    && window.openai.toolResponseMetadata[${JSON.stringify(SCREEN_IMAGE_META_KEY)}]
  if (image) document.getElementById("screen").src = image
}
render()
window.addEventListener("openai:set_globals", render)
</script>
`

/** The chat widget that shows a screenshot to the user; ChatGPT does not display tool images itself. */
export function registerScreenViewer(server: McpServer): void {
  server.registerResource(
    "screen-viewer",
    SCREEN_VIEWER_URI,
    { mimeType: VIEWER_MIME_TYPE },
    (uri: URL) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: VIEWER_MIME_TYPE,
          text: VIEWER_HTML,
          _meta: {
            "openai/widgetDescription": "Screenshot of the user's desktop.",
            "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
          },
        },
      ],
    })
  )
}
