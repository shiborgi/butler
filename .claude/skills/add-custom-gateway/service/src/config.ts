/**
 * The gateway's policy document — the whole of this install's LLM and MCP
 * configuration, and the only place upstream credentials are named.
 *
 * Two files, mounted read-only:
 *   config/gateway.json  — routing and policy, safe to commit or share
 *   config/secrets.env   — the credential values, never committed
 *
 * They are split because they have different lifetimes and different audiences.
 * The policy is what an operator reads and edits to answer "which model does
 * the bar assistant use"; the secrets are what must never appear in a diff, a
 * log line, or an agent's environment. The policy references a secret by NAME
 * only, so it can be shown to anyone.
 *
 * Both are re-read per request rather than cached at boot. The gateway is one
 * small process on a local network and a file read is nothing next to the
 * upstream round trip it is about to make; in exchange, editing a model or
 * rotating a key takes effect on the next call instead of requiring a restart
 * that would drop in-flight sessions.
 */
import { BUILTIN_NAMES as BUILTIN_MCP_NAMES } from './google-tools.js';

/** How a credential is presented to an upstream. */
export interface UpstreamAuth {
  /** Header name, e.g. `Authorization` or `x-api-key`. */
  header: string;
  /** Template with `{value}` where the secret goes, e.g. `Bearer {value}`. */
  format: string;
  /** Key in `secrets.env`. The value never appears in this document. */
  secret: string;
}

export interface GoogleOAuthProfile {
  provider: 'google';
  /** Account which must complete the consent flow. */
  expectedEmail: string;
  clientIdSecret: string;
  clientSecretSecret: string;
  refreshTokenSecret: string;
  scopes: string[];
}

export type McpAuth = UpstreamAuth | { kind: 'oauth2'; profile: string };

export interface Upstream {
  /** Base URL including any version prefix, e.g. `https://api.anthropic.com/v1`. */
  baseUrl: string;
  auth?: UpstreamAuth;
}

export interface ModelRoute {
  upstream: string;
  /** The upstream's own name for the model, when it differs from the alias. */
  model?: string;
}

export interface McpRoute {
  /** A proxied server. Exactly one of `url` or `builtin` is set. */
  url?: string;
  /**
   * A server the gateway implements itself (see google-mcp.ts). Chosen over a
   * hosted URL where the hosted one is gated or absent: Google's Drive and
   * Calendar MCP servers require Workspace Developer Preview enrolment, and
   * Tasks has none at all, while the REST APIs beneath them are general.
   */
  builtin?: string;
  auth?: McpAuth;
}

/**
 * A read-only HTTP route for files an agent saves to disk — a listing's photo,
 * say — so the bytes go to the file and never through the model's context.
 * GET and HEAD only, limited to the content types listed and to a size.
 */
export interface FileRoute {
  /** Base URL; the caller's path below `/files/<name>/` is appended to it. */
  url: string;
  auth?: UpstreamAuth;
  /** Accepted `content-type` prefixes, e.g. `image/`. */
  contentTypes: string[];
  maxBytes: number;
}

export interface AgentPolicy {
  /** Model aliases this agent may use. `["*"]` means every configured model. */
  models: string[];
  /** MCP server names this agent may reach. `["*"]` means every configured one. */
  mcpServers: string[];
  /** File route names this agent may read. `["*"]` means every configured one. */
  files: string[];
}

export interface GatewayConfig {
  schemaVersion: number;
  upstreams: Record<string, Upstream>;
  models: Record<string, ModelRoute>;
  mcpServers: Record<string, McpRoute>;
  oauthProfiles: Record<string, GoogleOAuthProfile>;
  fileRoutes: Record<string, FileRoute>;
  /** Keyed by agent group id. `*` is the fallback for a group with no entry. */
  agents: Record<string, AgentPolicy>;
}

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigError';
  }
}

/**
 * Resolved per call, not at module load. Reading these at import time would
 * freeze them before a caller could set them, and would quietly contradict the
 * re-read-per-request behavior this module exists to provide.
 */
function configPath(): string {
  return process.env.GATEWAY_CONFIG ?? '/app/config/gateway.json';
}
function secretsPath(): string {
  return process.env.GATEWAY_SECRETS ?? '/app/config/secrets.env';
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GatewayConfigError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayConfigError(`${field} must be a non-empty string`);
  }
  return value;
}

function parseAuth(raw: unknown, field: string): UpstreamAuth | undefined {
  if (raw === undefined) return undefined;
  const auth = requireObject(raw, field);
  const format = requireString(auth.format, `${field}.format`);
  if (!format.includes('{value}')) {
    // Without the placeholder the credential would silently never be sent, and
    // the failure would surface as an upstream 401 with nothing pointing here.
    throw new GatewayConfigError(`${field}.format must contain {value}`);
  }
  return {
    header: requireString(auth.header, `${field}.header`),
    format,
    secret: requireString(auth.secret, `${field}.secret`),
  };
}

export function parseConfig(raw: string): GatewayConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayConfigError('gateway.json is not valid JSON');
  }
  const doc = requireObject(parsed, 'gateway.json');
  if (doc.schemaVersion !== 1) {
    throw new GatewayConfigError(`unsupported schemaVersion ${String(doc.schemaVersion)}; this gateway understands 1`);
  }

  const upstreams: Record<string, Upstream> = {};
  for (const [name, value] of Object.entries(requireObject(doc.upstreams ?? {}, 'upstreams'))) {
    const entry = requireObject(value, `upstreams.${name}`);
    upstreams[name] = {
      baseUrl: requireString(entry.baseUrl, `upstreams.${name}.baseUrl`).replace(/\/+$/, ''),
      auth: parseAuth(entry.auth, `upstreams.${name}.auth`),
    };
  }

  const models: Record<string, ModelRoute> = {};
  for (const [alias, value] of Object.entries(requireObject(doc.models ?? {}, 'models'))) {
    const entry = requireObject(value, `models.${alias}`);
    const upstream = requireString(entry.upstream, `models.${alias}.upstream`);
    if (!upstreams[upstream]) {
      throw new GatewayConfigError(`models.${alias}.upstream "${upstream}" is not a configured upstream`);
    }
    models[alias] = { upstream, model: typeof entry.model === 'string' ? entry.model : undefined };
  }

  const oauthProfiles: Record<string, GoogleOAuthProfile> = {};
  for (const [name, value] of Object.entries(requireObject(doc.oauthProfiles ?? {}, 'oauthProfiles'))) {
    const entry = requireObject(value, `oauthProfiles.${name}`);
    if (entry.provider !== 'google') throw new GatewayConfigError(`oauthProfiles.${name}.provider must be "google"`);
    const scopes = entry.scopes;
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || !scope)) {
      throw new GatewayConfigError(`oauthProfiles.${name}.scopes must be an array of non-empty strings`);
    }
    oauthProfiles[name] = {
      provider: 'google',
      expectedEmail: requireString(entry.expectedEmail, `oauthProfiles.${name}.expectedEmail`),
      clientIdSecret: requireString(entry.clientIdSecret, `oauthProfiles.${name}.clientIdSecret`),
      clientSecretSecret: requireString(entry.clientSecretSecret, `oauthProfiles.${name}.clientSecretSecret`),
      refreshTokenSecret: requireString(entry.refreshTokenSecret, `oauthProfiles.${name}.refreshTokenSecret`),
      scopes,
    };
  }

  const mcpServers: Record<string, McpRoute> = {};
  for (const [name, value] of Object.entries(requireObject(doc.mcpServers ?? {}, 'mcpServers'))) {
    const entry = requireObject(value, `mcpServers.${name}`);
    const builtin = typeof entry.builtin === 'string' ? entry.builtin : undefined;
    if (builtin !== undefined && entry.url !== undefined) {
      throw new GatewayConfigError(`mcpServers.${name} sets both url and builtin; use exactly one`);
    }
    if (builtin !== undefined && !BUILTIN_MCP_NAMES.includes(builtin)) {
      throw new GatewayConfigError(
        `mcpServers.${name}.builtin "${builtin}" is not a built-in server (${BUILTIN_MCP_NAMES.join(', ')})`,
      );
    }
    mcpServers[name] = {
      ...(builtin === undefined ? { url: requireString(entry.url, `mcpServers.${name}.url`) } : { builtin }),
      auth:
        typeof entry.auth === 'object' &&
        entry.auth !== null &&
        (entry.auth as Record<string, unknown>).kind === 'oauth2'
          ? {
              kind: 'oauth2',
              profile: requireString(
                (entry.auth as Record<string, unknown>).profile,
                `mcpServers.${name}.auth.profile`,
              ),
            }
          : parseAuth(entry.auth, `mcpServers.${name}.auth`),
    };
  }

  const fileRoutes: Record<string, FileRoute> = {};
  for (const [name, value] of Object.entries(requireObject(doc.fileRoutes ?? {}, 'fileRoutes'))) {
    const entry = requireObject(value, `fileRoutes.${name}`);
    const url = requireString(entry.url, `fileRoutes.${name}.url`).replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw new GatewayConfigError(`fileRoutes.${name}.url must be an http(s) URL`);
    const types = entry.contentTypes ?? ['image/'];
    if (!Array.isArray(types) || types.length === 0 || types.some((t) => typeof t !== 'string' || !t)) {
      throw new GatewayConfigError(`fileRoutes.${name}.contentTypes must be a non-empty array of strings`);
    }
    const maxBytes = entry.maxBytes ?? 10_000_000;
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 50_000_000) {
      throw new GatewayConfigError(`fileRoutes.${name}.maxBytes must be an integer from 1 to 50000000`);
    }
    fileRoutes[name] = {
      url,
      auth: parseAuth(entry.auth, `fileRoutes.${name}.auth`),
      contentTypes: types as string[],
      maxBytes,
    };
  }

  const agents: Record<string, AgentPolicy> = {};
  for (const [id, value] of Object.entries(requireObject(doc.agents ?? {}, 'agents'))) {
    const entry = requireObject(value, `agents.${id}`);
    const list = (field: 'models' | 'mcpServers' | 'files'): string[] => {
      const raw = entry[field] ?? [];
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
        throw new GatewayConfigError(`agents.${id}.${field} must be an array of strings`);
      }
      return raw as string[];
    };
    agents[id] = { models: list('models'), mcpServers: list('mcpServers'), files: list('files') };
  }

  for (const [name, route] of Object.entries(mcpServers)) {
    if (route.auth && 'kind' in route.auth && !oauthProfiles[route.auth.profile]) {
      throw new GatewayConfigError(`mcpServers.${name}.auth.profile "${route.auth.profile}" is not configured`);
    }
  }
  return { schemaVersion: 1, upstreams, models, mcpServers, oauthProfiles, fileRoutes, agents };
}

/** `KEY=value` lines; `#` comments and blanks ignored. Values are not unquoted-parsed beyond trimming. */
export function parseSecrets(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface LoadedConfig {
  config: GatewayConfig;
  secrets: Record<string, string>;
}

export async function loadConfig(
  configFilePath: string = configPath(),
  secretsFilePath: string = secretsPath(),
): Promise<LoadedConfig> {
  const configFile = Bun.file(configFilePath);
  if (!(await configFile.exists())) {
    throw new GatewayConfigError(`no gateway policy at ${configFilePath}`);
  }
  const config = parseConfig(await configFile.text());
  // Secrets are optional: a config whose upstreams need no credential (a local
  // model server, say) is legitimate, and demanding the file would block it.
  const secretsFile = Bun.file(secretsFilePath);
  const secrets = (await secretsFile.exists()) ? parseSecrets(await secretsFile.text()) : {};
  return { config, secrets };
}

/** The policy for one agent group: its own entry, else the `*` fallback. */
export function policyFor(config: GatewayConfig, agentGroupId: string): AgentPolicy | null {
  return config.agents[agentGroupId] ?? config.agents['*'] ?? null;
}

/** `["*"]` is the wildcard; otherwise membership is exact. */
export function allows(list: readonly string[], name: string): boolean {
  return list.includes('*') || list.includes(name);
}

/** The header a request to this upstream must carry, or null when it needs none. */
export function authHeader(
  auth: UpstreamAuth | undefined,
  secrets: Record<string, string>,
): { name: string; value: string } | null {
  if (!auth) return null;
  const secret = secrets[auth.secret];
  if (!secret) {
    throw new GatewayConfigError(`secret "${auth.secret}" is not set in secrets.env`);
  }
  return { name: auth.header, value: auth.format.replace('{value}', secret) };
}
