import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname } from "node:path"
import process from "node:process"
import {
  type AuthProvider,
  type AuthResult,
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  OAuthError,
  OAuthErrorCode,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  UnauthorizedError,
} from "@modelcontextprotocol/client"
import { isRecord } from "../../utils.js"

const CALLBACK_PATH = "/oauth/callback"
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000
const LOGIN_REJECTED_CODES: string[] = [
  OAuthErrorCode.InvalidGrant,
  OAuthErrorCode.InvalidClient,
  OAuthErrorCode.UnauthorizedClient,
]
// Runtime never starts an authorization, but the SDK treats a missing redirect as a machine flow.
const RUNTIME_REDIRECT_URL = `http://127.0.0.1${CALLBACK_PATH}`

interface StoredLogin {
  url: string
  clientInformation: StoredOAuthClientInformation
  tokens: StoredOAuthTokens
}

export interface ExternalMcpLoginOptions {
  url: string
  storePath: string
  onAuthorizationUrl: (url: URL) => void | Promise<void>
  timeoutMs?: number
}

/**
 * Authorize through the login stored for this URL, without ever starting a new login.
 *
 * The store is read on every use so a login finished in another process applies immediately.
 * Concurrent 401s share one refresh, because servers that rotate refresh tokens reject the second.
 */
export function createStoredAuthProvider(storePath: string, url: string): AuthProvider {
  const provider = new StoredOAuthProvider(storePath, url)
  let refreshing: Promise<void> | undefined
  const refresh = async (ctx: Parameters<NonNullable<AuthProvider["onUnauthorized"]>>[0]) => {
    const result = await auth(provider, {
      serverUrl: ctx.serverUrl,
      fetchFn: ctx.fetchFn,
      ...extractWWWAuthenticateParams(ctx.response),
    }).catch((error: unknown): AuthResult => {
      // A rejected grant or client can only be fixed by signing in; anything else may be transient.
      if (error instanceof OAuthError && LOGIN_REJECTED_CODES.includes(error.code))
        return "REDIRECT"
      throw error
    })
    if (result !== "AUTHORIZED") throw new UnauthorizedError("The stored login has expired.")
  }
  return {
    token: async () => (await provider.tokens())?.access_token,
    onUnauthorized: (ctx) => {
      refreshing ??= refresh(ctx).finally(() => {
        refreshing = undefined
      })
      return refreshing
    },
  }
}

/** Run the browser authorization for one server and store the result only if it succeeds. */
export async function loginExternalMcpServer(options: ExternalMcpLoginOptions): Promise<void> {
  const state = randomBytes(32).toString("base64url")
  let resolveCallback: (params: URLSearchParams) => void = () => undefined
  let rejectCallback: (error: Error) => void = () => undefined
  const callback = new Promise<URLSearchParams>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  // The timeout can reject this before the login starts awaiting it.
  callback.catch(() => undefined)
  const server = createServer((req, res) => {
    const request = new URL(req.url ?? "/", "http://127.0.0.1")
    // Unrelated local requests must not be able to end or poison the login.
    if (
      req.method !== "GET" ||
      request.pathname !== CALLBACK_PATH ||
      request.searchParams.get("state") !== state
    ) {
      res.writeHead(404).end()
      return
    }
    res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end(
        request.searchParams.has("error")
          ? "Login failed. Return to the terminal."
          : "Login complete. You can close this tab."
      )
    resolveCallback(request.searchParams)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
  const timer = setTimeout(
    () => rejectCallback(new Error("Timed out waiting for the browser login.")),
    timeoutMs
  )
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("The login listener has no port.")
    const { port } = address
    const provider = new LoginOAuthProvider(`http://127.0.0.1:${port}${CALLBACK_PATH}`, state)

    const started = await auth(provider, { serverUrl: options.url })
    if (started !== "REDIRECT" || !provider.authorizationUrl) {
      throw new Error("The server did not start a browser authorization.")
    }
    await options.onAuthorizationUrl(provider.authorizationUrl)

    const params = await callback
    const refused = params.get("error")
    if (refused) throw new Error(`The server refused the login: ${refused}`)
    const code = params.get("code")
    if (!code) throw new Error("The login callback did not include an authorization code.")

    const finished = await auth(provider, {
      serverUrl: options.url,
      authorizationCode: code,
      iss: params.get("iss") ?? undefined,
    })
    if (finished !== "AUTHORIZED" || !provider.storedClient || !provider.storedTokens) {
      throw new Error("The server did not complete the login.")
    }
    await writeLogin(options.storePath, {
      url: options.url,
      clientInformation: provider.storedClient,
      tokens: provider.storedTokens,
    })
  } finally {
    clearTimeout(timer)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

class StoredOAuthProvider implements OAuthClientProvider {
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storePath: string,
    private readonly url: string
  ) {}

  get redirectUrl(): string {
    return RUNTIME_REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadata(RUNTIME_REDIRECT_URL)
  }

  async clientInformation(): Promise<StoredOAuthClientInformation> {
    const login = await readLogin(this.storePath, this.url)
    // Failing here stops the SDK from registering a new OAuth client on every unauthenticated call.
    if (!login) throw new UnauthorizedError("No stored login for this server.")
    return login.clientInformation
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await readLogin(this.storePath, this.url))?.tokens
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation): Promise<void> {
    return this.update({ clientInformation })
  }

  saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    return this.update({ tokens })
  }

  // An expired login reaches these and then fails as unauthorized; only the login command can
  // complete a browser authorization.
  redirectToAuthorization(): void {}
  saveCodeVerifier(): void {}
  codeVerifier(): string {
    throw new UnauthorizedError("No login is in progress for this server.")
  }

  private update(change: Partial<StoredLogin>): Promise<void> {
    const write = this.writes.then(async () => {
      const login = await readLogin(this.storePath, this.url)
      if (login) await writeLogin(this.storePath, { ...login, ...change })
    })
    this.writes = write.catch(() => undefined)
    return write
  }
}

/** Keeps a new client and its tokens in memory, so a failed login leaves the stored one intact. */
class LoginOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL
  storedClient?: StoredOAuthClientInformation
  storedTokens?: StoredOAuthTokens
  private verifier?: string
  private discovery?: OAuthDiscoveryState

  constructor(
    readonly redirectUrl: string,
    private readonly stateValue: string
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadata(this.redirectUrl)
  }

  state(): string {
    return this.stateValue
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.storedClient
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
    this.storedClient = clientInformation
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.storedTokens
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.storedTokens = tokens
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("The login has no PKCE verifier.")
    return this.verifier
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery
  }
}

function clientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: "Shellby MCP",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }
}

async function readLogin(path: string, url: string): Promise<StoredLogin | undefined> {
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
  let login: unknown
  try {
    login = JSON.parse(source)
  } catch {
    // Signing in again replaces a corrupt file. JSON errors quote file content, so drop them.
    return undefined
  }
  // A login is bound to its URL, so editing the config can never send a token to another server.
  return isStoredLogin(login) && login.url === url ? login : undefined
}

function isStoredLogin(value: unknown): value is StoredLogin {
  return isRecord(value) && isRecord(value.clientInformation) && isRecord(value.tokens)
}

async function writeLogin(path: string, login: StoredLogin): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(login), { encoding: "utf8", mode: 0o600 })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
