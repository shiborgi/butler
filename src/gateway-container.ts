/**
 * The gateway container: this install's only route off the host.
 *
 * Topology, and why it is this one:
 *
 *   [agent]  ── nanoclaw-egress-v2-<slug> (hostOnly, no internet) ──┐
 *                                                                   ├─ [gateway]
 *                                            default (NAT) ─────────┘      │
 *                                                                          └──> upstreams
 *
 * The gateway is multi-homed: one leg on the install's host-only network where
 * the agents live, one on the NAT network that has a route out. Agents reach
 * it at its host-only address and can reach nothing else — not the internet,
 * not another install's gateway.
 *
 * Nothing is published to the host. Two earlier shapes were tried and
 * rejected against the live runtime:
 *
 * - `-p <hostOnly-gateway-ip>:8080:8080` fails outright (`Can't assign
 *   requested address`): that address exists on the host only while the
 *   network has a member, which is circular — the gateway would have to be
 *   running for the gateway to be able to start.
 * - `-p 8080:8080` binds 0.0.0.0, putting the gateway on every host interface
 *   including the LAN, and forces a distinct host port per install.
 *
 * Multi-homing needs neither. It also means the address is DHCP-assigned, so
 * it is resolved fresh on every spawn rather than cached — a gateway that was
 * recreated comes back at a different IP and the next session simply learns it.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { egressNetworkName, ensureEgressNetwork } from './apple-container-network.js';
import { ensureGatewayConfigScaffold, ensureGatewaySecret } from './gateway-bootstrap.js';
import { GATEWAY_SECRET_ENV } from './gateway-identity.js';
import { getInstallSlug } from './install-slug.js';
import { log } from './log.js';

import { realCli, validateRuntimeName, type Cli } from './drivers/cli.js';

/** The port the service listens on inside its container. Never published. */
export const GATEWAY_PORT = 8080;

/** The NAT network that gives the gateway — and only the gateway — a route out. */
const UPSTREAM_NETWORK = 'default';
const GATEWAY_REVISION_LABEL = 'nanoclaw-gateway-revision';

/**
 * Hash only the files copied by gateway/Dockerfile. Runtime policy and secrets
 * live under gateway/config and are mounted read-only, so they must never be
 * folded into an image identity (or read while calculating one).
 */
export function gatewaySourceRevision(projectRoot: string = process.cwd()): string {
  const gatewayRoot = path.join(projectRoot, 'gateway');
  const roots = ['Dockerfile', 'package.json', 'tsconfig.json', 'src'];
  const files: string[] = [];
  const visit = (relative: string): void => {
    const absolute = path.join(gatewayRoot, relative);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(relative, entry));
      return;
    }
    if (stat.isFile()) files.push(relative);
  };
  for (const root of roots) visit(root);

  const hash = createHash('sha256');
  for (const relative of files.sort()) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(gatewayRoot, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export class GatewayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayUnavailableError';
  }
}

export function gatewayImageTag(projectRoot?: string): string {
  const revision = gatewaySourceRevision(projectRoot);
  return `nanoclaw-gateway-v2-${getInstallSlug(projectRoot)}-${revision.slice(0, 12)}:latest`;
}

export function gatewayContainerName(projectRoot?: string): string {
  return validateRuntimeName(`nanoclaw-gateway-v2-${getInstallSlug(projectRoot)}`, 'container');
}

export interface GatewayContainerRecord {
  id?: string;
  configuration?: { id?: string; labels?: Record<string, string> };
  status?: { state?: string; networks?: Array<{ network?: string; ipv4Address?: string }> };
}

function parseRecords(output: string): GatewayContainerRecord[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as GatewayContainerRecord[]) : [parsed as GatewayContainerRecord];
  } catch {
    return [];
  }
}

/** The gateway's address on the host-only network, or null when it is not up there. */
export function addressOnNetwork(
  records: readonly GatewayContainerRecord[],
  name: string,
  network: string,
): string | null {
  const record = records.find((r) => (r.configuration?.id ?? r.id) === name);
  if (!record || record.status?.state !== 'running') return null;
  const leg = record.status?.networks?.find((n) => n.network === network);
  return leg?.ipv4Address?.split('/')[0] ?? null;
}

function listContainers(cli: Cli): GatewayContainerRecord[] {
  try {
    return parseRecords(cli.run(['list', '--all', '--format', 'json'], { timeoutMs: 20_000 }));
  } catch (error) {
    throw new GatewayUnavailableError(
      `the container runtime is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Build the gateway image if this install does not have one.
 *
 * Tagged per install so two clones on one Mac never share an image: the
 * runtime's image store is machine-wide, and a shared tag would mean one
 * install's rebuild silently redefines the other's gateway.
 */
export function ensureGatewayImage(cli: Cli = realCli('container'), projectRoot: string = process.cwd()): void {
  const tag = gatewayImageTag(projectRoot);
  try {
    cli.run(['image', 'inspect', tag], { timeoutMs: 20_000 });
    return;
  } catch {
    // Absent — fall through and build it.
  }
  log.info('Building gateway image', { tag });
  try {
    // Long: a cold build pulls a base image and installs dependencies.
    cli.run(['build', '-t', tag, path.join(projectRoot, 'gateway')], { timeoutMs: 900_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GatewayUnavailableError(`the gateway image could not be built: ${detail}`);
  }
  log.info('Gateway image built', { tag });
}

/**
 * Ensure the gateway container is running and return its host-only address.
 *
 * Idempotent and self-healing: a container that exists but is not running is
 * removed and recreated rather than restarted, because its network legs and
 * mounts are decided at create time and an install whose config or egress
 * network changed must not keep running against the old ones.
 */
export function ensureGatewayRunning(cli: Cli = realCli('container'), projectRoot: string = process.cwd()): string {
  const name = gatewayContainerName(projectRoot);
  const egress = egressNetworkName(process.env, projectRoot);
  const revision = gatewaySourceRevision(projectRoot);
  const records = listContainers(cli);
  const record = records.find((candidate) => (candidate.configuration?.id ?? candidate.id) === name);

  const existing = addressOnNetwork(records, name, egress);
  if (existing && record?.configuration?.labels?.[GATEWAY_REVISION_LABEL] === revision) return existing;

  if (existing) {
    log.info('Replacing stale gateway container', {
      container: name,
      expectedRevision: revision.slice(0, 12),
      actualRevision: record?.configuration?.labels?.[GATEWAY_REVISION_LABEL]?.slice(0, 12) ?? 'unversioned',
    });
  }

  // The network has to exist before anything can be attached to it, and on a
  // fresh machine nothing has created it yet: the session driver also ensures
  // it, but that happens later, when a message arrives. Ensuring it here is
  // what makes the gateway the FIRST thing that can come up.
  ensureEgressNetwork(cli, process.env);

  // Remove any non-running remnant so `run` cannot collide on the name.
  try {
    cli.run(['rm', '--force', name], { timeoutMs: 30_000 });
  } catch {
    /* nothing to remove */
  }

  ensureGatewayImage(cli, projectRoot);

  // Create-if-absent rather than demand: a fresh clone has neither the secret
  // nor a policy file, and requiring a setup step before the first start is a
  // documented sequence someone gets wrong on the machine where it matters.
  ensureGatewayConfigScaffold(projectRoot);
  const secret = ensureGatewaySecret(projectRoot);

  const args = [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    // Multi-homed, and the ORDER is load-bearing: the runtime takes the
    // default route and the nameserver from the FIRST network. Listing the
    // host-only network first leaves the gateway with `default via
    // <hostOnly gateway>` and a nameserver on a segment with no egress —
    // every upstream call then fails DNS resolution and times out, while
    // /health/live keeps answering and the container looks healthy.
    '--network',
    UPSTREAM_NETWORK,
    '--network',
    egress,
    '--label',
    `nanoclaw-install=${getInstallSlug(projectRoot)}`,
    '--label',
    'nanoclaw-role=gateway',
    '--label',
    `${GATEWAY_REVISION_LABEL}=${revision}`,
    '--cap-drop',
    'ALL',
    '--init',
    '-e',
    `${GATEWAY_SECRET_ENV}=${secret}`,
    '-e',
    `GATEWAY_PORT=${GATEWAY_PORT}`,
    // Config and its secrets are the gateway's alone — mounted here, never
    // into an agent, and read-only so a compromised gateway cannot rewrite
    // its own policy.
    '-v',
    `${path.join(projectRoot, 'gateway', 'config')}:/app/config:ro`,
    gatewayImageTag(projectRoot),
  ];

  try {
    cli.run(args, { timeoutMs: 120_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GatewayUnavailableError(`the gateway container could not be started: ${detail}`);
  }

  const address = addressOnNetwork(listContainers(cli), name, egress);
  if (!address) {
    throw new GatewayUnavailableError(`the gateway started but has no address on "${egress}"`);
  }
  log.info('Gateway container running', { container: name, address, network: egress });
  return address;
}

/** The base URL an agent on the host-only network uses to reach the gateway. */
export function gatewayBaseUrl(address: string): string {
  return `http://${address}:${GATEWAY_PORT}`;
}

/**
 * Liveness, asked from inside the gateway container.
 *
 * NOT an HTTP call from the host, though the host does hold an address on the
 * gateway's network. On current macOS, a host process reaching a container IP
 * is subject to the Local Network privacy control, and the host service is not
 * an app a user has granted anything to: `curl` from a permitted Terminal
 * succeeds while the very same request from the Node process fails
 * `EHOSTUNREACH`. A probe that fails for a reason unrelated to the gateway's
 * health is worse than no probe — it would refuse every spawn on a perfectly
 * healthy install.
 *
 * Asking the container about itself goes through the runtime instead, which
 * needs no such permission, and answers the question that actually matters:
 * is the service inside listening.
 */
export async function probeGateway(
  cli: Cli = realCli('container'),
  projectRoot: string = process.cwd(),
): Promise<boolean> {
  try {
    const out = cli.run(
      ['exec', gatewayContainerName(projectRoot), 'wget', '-qO-', `http://127.0.0.1:${GATEWAY_PORT}/health/live`],
      { timeoutMs: 10_000 },
    );
    return out.includes('ok');
  } catch {
    return false;
  }
}

/**
 * The gateway's last words, for a failure that would otherwise be silent.
 *
 * A gateway that starts and immediately exits leaves nothing behind — `--rm`
 * removes it — so by the time anything notices, the only evidence is gone.
 * Read while it may still exist, and treat "no logs" as its own answer rather
 * than an error.
 */
export function gatewayLogTail(
  cli: Cli = realCli('container'),
  projectRoot: string = process.cwd(),
  lines = 12,
): string {
  try {
    const out = cli.run(['logs', gatewayContainerName(projectRoot)], { timeoutMs: 10_000 });
    return out.trim().split('\n').slice(-lines).join('\n') || '(no output)';
  } catch {
    return '(container is already gone; it exited immediately)';
  }
}

/**
 * Wait for the gateway to start answering.
 *
 * A container that has just been created is not yet a service that is
 * listening, and the gap is on the order of a second. Probing once right after
 * `run` reports a healthy gateway as dead — which, on the spawn path, would
 * refuse a session that was about to work.
 */
export async function awaitGatewayLive(
  timeoutMs = 20_000,
  cli: Cli = realCli('container'),
  projectRoot: string = process.cwd(),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probeGateway(cli, projectRoot)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The gateway's address, resolved at most once per short window.
 *
 * Both the spawn path's config materialization and the gateway provider's
 * contribution need this address, and they run at different moments of the
 * same spawn. Memoizing keeps that to one `list` round trip without either
 * caller having to thread the value to the other. The window is short because
 * the address is DHCP-assigned: a gateway recreated between sessions comes
 * back at a different IP, and a stale value would point every new session at
 * nothing.
 */
const ADDRESS_TTL_MS = 10_000;
let cached: { address: string; at: number } | null = null;

export function resolveGatewayAddress(cli: Cli = realCli('container'), projectRoot: string = process.cwd()): string {
  if (cached && Date.now() - cached.at < ADDRESS_TTL_MS) return cached.address;
  const address = ensureGatewayRunning(cli, projectRoot);
  cached = { address, at: Date.now() };
  return address;
}

/** Test seam, and the invalidation a deliberate gateway restart needs. */
export function forgetGatewayAddress(): void {
  cached = null;
}
