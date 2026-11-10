import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"

const policyUrl = new URL("../../../browser-extension/policy.js", import.meta.url)
const policy = await import(policyUrl.href)

test("only http(s) pages can be approved and blank tabs need no approval", () => {
  assert.deepEqual(policy.classifyUrl("about:blank"), { kind: "blank" })
  assert.deepEqual(policy.classifyUrl("https://a.example/x?y=1"), {
    kind: "site",
    origin: "https://a.example",
  })
  for (const url of ["chrome://settings", "file:///etc/passwd", "javascript:alert(1)", "::"]) {
    assert.deepEqual(policy.classifyUrl(url), { kind: "protected" })
  }
  assert.equal(policy.isApprovalOrigin("https://a.example"), true)
  assert.equal(policy.isApprovalOrigin("https://a.example/path"), false)
  assert.equal(policy.isApprovalOrigin("chrome-extension://abc"), false)
})

test("pairing codes are strictly shaped", () => {
  const secret = "f".repeat(64)
  assert.deepEqual(policy.parsePairing(` shellby:3335:${secret}\n`), { port: 3335, secret })
  assert.equal(policy.parsePairing(`shellby:99999:${secret}`), undefined)
  assert.equal(policy.parsePairing("shellby:3335:short"), undefined)
})

test("log URLs lose query credentials but keep the rest", () => {
  assert.equal(
    policy.redactUrl("https://u:p@a.example/x?access_token=abc&page=2"),
    "https://a.example/x?access_token=REDACTED&page=2"
  )
})

test("key combos map to CDP key events", () => {
  assert.deepEqual(policy.parseKeyCombo("Enter"), {
    key: "Enter",
    code: "Enter",
    vk: 13,
    text: "\r",
    modifiers: 0,
  })
  const selectAll = policy.parseKeyCombo("ctrl+a")
  assert.equal(selectAll.modifiers, 2)
  assert.equal(selectAll.text, undefined)
  assert.equal(policy.parseKeyCombo("shift+a").text, "a")
  assert.equal(policy.parseKeyCombo("ctrl++").key, "+")
  assert.equal(policy.parseKeyCombo("hyper+a"), undefined)
  assert.equal(policy.parseKeyCombo("notakey"), undefined)
})

test("the worker's HMAC matches the server's", async () => {
  assert.equal(
    await policy.hmacHex("secret", "value"),
    createHmac("sha256", "secret").update("value").digest("hex")
  )
})
