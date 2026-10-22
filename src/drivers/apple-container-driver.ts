/**
 * Apple Container driver — SessionDriver realization over the local `container` CLI.
 *
 * Same seam as DockerSessionDriver: Cli injection, validateSpec, withSessionEvents,
 * adoption from labels alone. The differences are dialect, not semantics, and each
 * one this runtime cannot express is declared in `capabilities().unrealized`
 * rather than faked:
 *
 * - No `events` subcommand. `watchSessions` polls `list --all --format json` and
 *   diffs, which the seam permits because events are best-effort hints and the
 *   session-events hub re-reads truth before firing `onTerminal`.
 * - No `--format` on `inspect`. Everything is parsed from JSON.
 * - No `--security-opt` and no `--pids-limit`. Each container is its own VM, so
 *   the no-new-privileges depth-in-defense that mattered under a shared kernel is
 *   supplied by the VM boundary; a per-session pid cap has no equivalent at all
 *   and is named in `unrealized`.
 * - Mounts are `-v host:container[:ro]`, byte-identical to Docker's dialect and
 *   verified to bind single FILES as well as directories with `:ro` genuinely
 *   enforced. (`--mount type=bind` rejects a file source here; `-v` does not.
 *   The distinction matters: composition mounts individual files — the session
 *   descriptor, the per-group config, the composed instruction document — and
 *   dropping them degrades the agent silently.)
 *
 * Network topology stays driver-private and is injected at registration, exactly
 * as `dockerNetworkArgs` is for Docker — `spec.network` states the intent, the
 * registration realizes it, and nothing argv-shaped rides between them.
 */
import { log } from '../log.js';

import { realCli, validateRuntimeName, type Cli, type SupervisedProcess } from './cli.js';
import { agentContainerName, assertMountSourcesExist, envArgs, labelArgs, mountArgs } from './docker-driver.js';
import {
  LABELS,
  asFailureError,
  labelsForKey,
  specInvalid,
  validateSpec,
  type DriverCapabilities,
  type MountPolicy,
  type NetworkAccessIntent,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionFailure,
  type SessionHandle,
  type SessionKey,
  type SessionPhase,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

const WATCH_INTERVAL_MS = 1_000;
const WATCH_MAX_BACKOFF_MS = 30_000;

export interface AppleContainerDriverOptions extends MountPolicy {
  cli?: Cli;
  /** Apple network topology, resolved by the runtime registration. */
  networkArgsFor?: (spec: SessionSpec) => string[];
  /** Re-realize a gateway destination for an adopted session — see `reconcileNetworkAccess`. */
  reconcileNetworkAccess?: (access: NetworkAccessIntent) => Promise<void> | void;
}

interface AppleWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  timer?: ReturnType<typeof setTimeout>;
  failures: number;
  stopped: boolean;
}

/**
 * The shapes `list` and `inspect` have emitted across CLI versions. Reading
 * through the accessors below rather than one fixed path means a shape change
 * degrades to "no labels" (the record is skipped) instead of a crash in the
 * poll loop that supervises every session at once.
 */
interface ContainerRecord {
  name?: string;
  id?: string;
  /** The live runtime nests state here: `{"status":{"state":"running"}}`. */
  status?: string | { state?: string };
  /** Older/alternate shapes put it at the top level, as a string or an object. */
  state?: string | { status?: string };
  labels?: Record<string, string>;
  configuration?: { id?: string; labels?: Record<string, string> };
  config?: { labels?: Record<string, string> };
}

export class AppleContainerSessionDriver implements SessionDriver {
  readonly kind = 'apple-container' as const;
  readonly #cli: Cli;
  readonly #policy: MountPolicy;
  readonly #networkArgs: ((spec: SessionSpec) => string[]) | undefined;
  readonly #reconcileNetwork: AppleContainerDriverOptions['reconcileNetworkAccess'];
  readonly #watches = new Map<string, AppleWatch>();
  /** Every key this driver handed out, per install — see the Docker driver's `#knownKeys`. */
  readonly #knownKeys = new Map<string, Map<string, SessionKey>>();
  /** What the previous poll saw, so a disappearance can be told from a first sighting. */
  readonly #listed = new Map<string, Set<string>>();

  constructor(opts: AppleContainerDriverOptions) {
    this.#cli = opts.cli ?? realCli('container');
    this.#policy = opts;
    this.#networkArgs = opts.networkArgsFor;
    this.#reconcileNetwork = opts.reconcileNetworkAccess;
  }

  /**
   * Restore what `networkArgsFor` realized for a session this host adopted
   * rather than spawned: after a restart the gateway may have been recreated
   * under a new address, and the session's hosts file must follow it.
   */
  async reconcileNetworkAccess(access: NetworkAccessIntent): Promise<void> {
    await this.#reconcileNetwork?.(access);
  }

  capabilities(): DriverCapabilities {
    return {
      // MUST include 'container': composition passes `runtimeTier ?? 'container'`
      // and validateSpec refuses a tier the driver does not list. Each container
      // is genuinely its own VM here, but the spec vocabulary for that is the
      // isolation the SESSION asked for, not the mechanism underneath.
      isolationTiers: ['container'],
      admissionEnforced: false,
      networkPolicy: 'topology',
      encryptedVolumes: false,
      // No `--pids-limit` equivalent. Declared, never faked.
      unrealized: ['pidsLimit'],
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      // `container build` targets the same image store this driver runs from.
      imageBuild: true,
    };
  }

  async ensureReady(): Promise<void> {
    try {
      this.#cli.run(['system', 'status'], { timeoutMs: 10_000 });
    } catch (error) {
      throw normalizeAppleContainerError(error);
    }
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());
    const extra = spec.containers.filter((c) => c.role !== 'agent');
    if (extra.length > 0) {
      // Refusal, not omission — realizing a subset would validate containers
      // that never exist. See the Docker driver for the full argument.
      throw specInvalid(
        `apple-container driver does not manage container role '${extra[0].role}'; ` +
          `auxiliary containers require a driver with capabilities().auxiliaryContainers`,
      );
    }
    const agent = spec.containers.find((c) => c.role === 'agent')!;
    const name = validateRuntimeName(agentContainerName(spec), 'container');
    this.#remember(spec.key);

    if (this.#existingSession(name, spec.key)) {
      return new AppleContainerHandle(spec.key, name, this.#cli, null, this.#emit);
    }

    assertMountSourcesExist(agent.mounts);

    const args = ['create', '--rm', '--name', name];
    args.push(...labelArgs(labelsForKey(spec.key, 'agent', { ...spec.labels, ...(agent.labels ?? {}) })));
    args.push(...resourceArgs(spec));
    args.push(...hardeningArgs());
    args.push(...userArgs(spec));
    // Composed env first, contributed env second: the contributed lane overrides
    // composed literals, which last-wins argv ordering realizes.
    args.push(...envArgs(agent.env));
    args.push(...envArgs(agent.contributedEnv ?? {}));
    args.push(...mountArgs(agent.mounts));
    args.push(...this.#networkArgsFor(spec));
    if (agent.command && agent.command.length > 0) {
      args.push('--entrypoint', agent.command[0], agent.image, ...agent.command.slice(1), ...(agent.args ?? []));
    } else {
      args.push(agent.image, ...(agent.args ?? []));
    }

    try {
      this.#cli.run(args);
    } catch (error) {
      try {
        this.#cli.run(['rm', '--force', name]);
      } catch {
        /* prepare is atomic: allocate all or leave nothing */
      }
      throw normalizeAppleContainerError(error);
    }
    return new AppleContainerHandle(spec.key, name, this.#cli, spec, this.#emit);
  }

  #networkArgsFor(spec: SessionSpec): string[] {
    if (spec.network === 'none') return ['--network', 'none'];
    return this.#networkArgs?.(spec) ?? [];
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    let output: string;
    try {
      output = this.#cli.run(['list', '--all', '--format', 'json']);
    } catch (error) {
      throw normalizeAppleContainerError(error);
    }
    const snapshots: SessionSnapshot[] = [];
    for (const record of parseContainerRecords(output)) {
      const labels = recordLabels(record);
      if (labels[LABELS.install] !== installSlug || labels[LABELS.role] !== 'agent') continue;
      const agentGroupId = labels[LABELS.group];
      const sessionId = labels[LABELS.session];
      if (!agentGroupId || !sessionId) continue;
      const name = recordName(record);
      if (!name) continue;
      const key: SessionKey = { installSlug, agentGroupId, sessionId };
      this.#remember(key);
      snapshots.push({
        handle: new AppleContainerHandle(key, validateRuntimeName(name, 'container'), this.#cli, null, this.#emit),
        phase: appleStatePhase(recordState(record)),
      });
    }
    return snapshots;
  }

  /**
   * One poll loop per install — never per session. There is no `container
   * events`, so truth is re-listed on an interval and diffed. Events are hints
   * by contract: the hub re-reads status before it fires a terminal, so a
   * duplicate or a late hint costs a status read, never a wrong conclusion.
   */
  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let watch = this.#watches.get(installSlug);
    if (!watch) {
      watch = { subscribers: new Set(), failures: 0, stopped: false };
      this.#watches.set(installSlug, watch);
      this.#schedulePoll(installSlug, watch, 0);
    }
    watch.subscribers.add(onEvent);
    return {
      stop: () => {
        watch.subscribers.delete(onEvent);
        if (watch.subscribers.size === 0) {
          watch.stopped = true;
          if (watch.timer) clearTimeout(watch.timer);
          if (this.#watches.get(installSlug) === watch) this.#watches.delete(installSlug);
        }
      },
    };
  }

  #schedulePoll(installSlug: string, watch: AppleWatch, delay: number): void {
    if (watch.stopped) return;
    watch.timer = setTimeout(() => void this.#poll(installSlug, watch), delay);
    watch.timer.unref?.();
  }

  async #poll(installSlug: string, watch: AppleWatch): Promise<void> {
    if (watch.stopped || this.#watches.get(installSlug) !== watch) return;
    try {
      const snapshots = await this.listSessions(installSlug);
      watch.failures = 0;
      const listed = new Set(snapshots.map((s) => keyId(s.handle.key)));
      const previous = this.#listed.get(installSlug) ?? new Set();
      this.#listed.set(installSlug, listed);
      for (const snapshot of snapshots) {
        this.#emit({
          key: snapshot.handle.key,
          kind:
            snapshot.phase === 'terminal' ? 'terminal' : previous.has(keyId(snapshot.handle.key)) ? 'hint' : 'phase',
        });
      }
      // A `--rm` container that exited between polls is gone from the listing
      // entirely, so only the known-key registry can name it. Gated on having
      // seen it previously: a key prepared but never listed is not a corpse.
      for (const [id, key] of this.#knownKeys.get(installSlug) ?? []) {
        if (!listed.has(id) && previous.has(id)) this.#emit({ key, kind: 'terminal' });
      }
    } catch {
      // A failed list is a gap, not a mass terminal. Back off and retry; the
      // listing is the only evidence, and absent evidence must not synthesize
      // terminals for every session at once.
      watch.failures += 1;
    }
    const delay = Math.min(WATCH_INTERVAL_MS * 2 ** watch.failures, WATCH_MAX_BACKOFF_MS);
    this.#schedulePoll(installSlug, watch, delay);
  }

  readonly #emit = (event: SessionEvent): void => {
    const watch = this.#watches.get(event.key.installSlug);
    if (!watch) return;
    for (const subscriber of watch.subscribers) subscriber(event);
  };

  #remember(key: SessionKey): void {
    let known = this.#knownKeys.get(key.installSlug);
    if (!known) {
      known = new Map();
      this.#knownKeys.set(key.installSlug, known);
    }
    known.set(keyId(key), key);
  }

  /**
   * The runtime is a machine-wide namespace shared by every install on this
   * Mac, so a name match alone cannot answer "is this MY session". Two clones
   * of this project are meant to coexist; the canonical labels are what keeps
   * one from adopting the other's container.
   */
  #existingSession(name: string, key: SessionKey): boolean {
    let record: ContainerRecord | null;
    try {
      record = inspectRecord(this.#cli, name);
    } catch (error) {
      if (isRuntimeUnavailable(error)) throw normalizeAppleContainerError(error);
      return false;
    }
    if (!record) return false;
    const labels = recordLabels(record);
    if (
      labels[LABELS.install] === key.installSlug &&
      labels[LABELS.group] === key.agentGroupId &&
      labels[LABELS.session] === key.sessionId
    ) {
      return true;
    }
    log.warn('Container name collision: existing container is not this session', {
      containerName: name,
      wanted: key,
      found: {
        install: labels[LABELS.install],
        group: labels[LABELS.group],
        session: labels[LABELS.session],
      },
    });
    throw asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `name-collision-${name}` });
  }
}

/**
 * An attach that ends this soon after start, without the host asking, is a
 * session that never really ran. The host respawns it, so without a record
 * here the only trace is a burst of `runtime-ended` lines with no cause.
 */
const EARLY_EXIT_MS = 10_000;

class AppleContainerHandle implements SessionHandle {
  #proc: SupervisedProcess | null = null;
  #startedAt = 0;
  /** Log hygiene only — events are never intent-filtered here (that is the hub's job). */
  #stopping = false;
  #attachExitCode: number | null | undefined;
  readonly #stderrTail: string[] = [];

  constructor(
    readonly key: SessionKey,
    readonly name: string,
    private readonly cli: Cli,
    /** Present only between prepare and start; null for an adopted handle. */
    private readonly pendingSpec: SessionSpec | null,
    private readonly emit: (event: SessionEvent) => void,
  ) {}

  async start(): Promise<void> {
    if (this.#proc) return; // idempotent
    // `start --attach` is the supervision channel: it exits with the container's
    // exit code and streams the stderr that explains a boot failure.
    const proc = this.cli.start(['start', '--attach', this.name]);
    this.#proc = proc;
    this.#startedAt = Date.now();
    proc.onStderr((line) => {
      log.debug(line, { container: this.name });
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 10) this.#stderrTail.shift();
    });
    proc.onExit((code) => {
      this.#attachExitCode = code;
      // A null code is a failure of the local attach helper, not evidence that
      // the VM stopped. The listing watch remains authoritative and will emit
      // a terminal once the container actually disappears. Emitting here
      // would race an immediate inspect and can mark a live session stopped.
      if (code === null) {
        log.warn('Container attach helper exited without a status; continuing supervision via runtime watch', {
          containerName: this.name,
        });
        return;
      }
      const elapsedMs = Date.now() - this.#startedAt;
      if (!this.#stopping && elapsedMs < EARLY_EXIT_MS) {
        log.warn('Container ended shortly after start', {
          containerName: this.name,
          code,
          elapsedMs,
          state: this.#stateForDiagnosis(),
          stderrTail: [...this.#stderrTail],
        });
      } else if (!this.#stopping && code !== 0 && this.#stderrTail.length > 0) {
        log.warn('Container exited non-zero', { containerName: this.name, code, stderrTail: this.#stderrTail });
      }
      this.emit({ key: this.key, kind: 'terminal' });
    });
  }

  /** What the runtime says right now, for a log line only; never throws. */
  #stateForDiagnosis(): string {
    try {
      const record = inspectRecord(this.cli, this.name);
      return record ? recordState(record) : 'absent';
    } catch (error) {
      return `inspect-failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
    }
  }

  async status(): Promise<SessionStatus> {
    let record: ContainerRecord | null;
    try {
      record = inspectRecord(this.cli, this.name);
    } catch (error) {
      if (isRuntimeUnavailable(error)) throw normalizeAppleContainerError(error);
      record = null;
    }
    if (!record) {
      // `--rm` means an exited container is already removed; the attach exit
      // code is the only record of how it ended.
      if (!this.#stopping && typeof this.#attachExitCode === 'number' && this.#attachExitCode !== 0) {
        return {
          phase: 'failed',
          failure: { kind: 'started-then-died', retryable: false, exitCode: this.#attachExitCode },
        };
      }
      // Gone, but the attach process holds the only record of HOW it ended and
      // has not exited yet. Reporting 'stopped' here would spend the hub's
      // at-most-once terminal without the exit code; the attach exit emits its
      // own hint, so deferring converges within one process exit.
      if (!this.#stopping && this.#proc && this.#attachExitCode === undefined) {
        return { phase: 'running' };
      }
      return this.pendingSpec && !this.#proc ? { phase: 'ready' } : { phase: 'stopped' };
    }
    const state = recordState(record);
    if (state === 'running') return { phase: 'running' };
    if (state === 'created') return { phase: 'ready' };
    // This runtime has no `created` state: a container that was created and
    // not yet started, and one whose `start` is still bringing the VM up,
    // both list as `stopped`. Read as ended, a listing poll that lands in that
    // window had the host kill a healthy session and respawn it. While this
    // handle's own attach is alive, the attach exit is the authority on
    // whether it ended, exactly as in the already-removed branch above.
    if (!this.#stopping && this.pendingSpec && !this.#proc) return { phase: 'ready' };
    if (!this.#stopping && this.#proc && this.#attachExitCode === undefined) return { phase: 'running' };
    // Anything else is ended. Unlike Docker, this runtime's `inspect` carries
    // NO exit code — a container that died with 7 reports only
    // `state: "stopped"` — so the attach process is the sole witness to how it
    // ended, exactly as in the already-removed branch above.
    if (!this.#stopping && typeof this.#attachExitCode === 'number' && this.#attachExitCode !== 0) {
      return {
        phase: 'failed',
        failure: { kind: 'started-then-died', retryable: false, exitCode: this.#attachExitCode },
      };
    }
    return { phase: 'stopped' };
  }

  async stop(reason: string): Promise<void> {
    const elapsedMs = Date.now() - this.#startedAt;
    if (!this.#stopping && this.#proc && elapsedMs < EARLY_EXIT_MS) {
      // A stop this early is the host reacting to something it saw; name it,
      // or a respawn burst reads as nothing but `runtime-ended`.
      log.warn('Session container stopped shortly after start', {
        containerName: this.name,
        reason,
        elapsedMs,
        state: this.#stateForDiagnosis(),
        attachExitCode: this.#attachExitCode,
        stderrTail: [...this.#stderrTail],
      });
    }
    this.#stopping = true;
    log.info('Stopping session container', { containerName: this.name, reason });
    const grace = String(this.pendingSpec?.stopGraceSeconds ?? 1);
    try {
      this.cli.run(['stop', '-t', grace, this.name]);
    } catch {
      // Already gone, or the runtime refused: kill the attach process so
      // supervision never hangs waiting for an exit that cannot come.
      this.#proc?.kill();
    }
    try {
      this.cli.run(['rm', '--force', this.name]);
    } catch {
      /* `--rm` usually got there first */
    }
  }

  execSpec(command: string[]): SessionExecSpec {
    const runAs = this.pendingSpec?.runAs ?? { uid: 1000, gid: 1000 };
    const identity = `${runAs.uid}:${runAs.gid}`;
    return {
      bin: 'container',
      // Apple `exec` otherwise defaults to root. The session init process has
      // already dropped privileges, and diagnostics must not reintroduce them.
      argsTty: ['exec', '-it', '--user', identity, this.name, ...command],
      argsPlain: ['exec', '-i', '--user', identity, this.name, ...command],
    };
  }
}

/** Collision-proof key identity for driver-internal maps (NUL cannot appear in a key part). */
function keyId(key: SessionKey): string {
  return `${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`;
}

function inspectRecord(cli: Cli, name: string): ContainerRecord | null {
  const output = cli.run(['inspect', name]);
  return parseContainerRecords(output)[0] ?? null;
}

/** `inspect` returns an array, `list --format json` an array, older builds NDJSON. Accept all three. */
export function parseContainerRecords(output: string): ContainerRecord[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as ContainerRecord[]) : [parsed as ContainerRecord];
  } catch {
    return trimmed
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ContainerRecord];
        } catch {
          return [];
        }
      });
  }
}

export function recordLabels(record: ContainerRecord): Record<string, string> {
  return record.labels ?? record.configuration?.labels ?? record.config?.labels ?? {};
}

export function recordName(record: ContainerRecord): string {
  return record.name ?? record.id ?? record.configuration?.id ?? '';
}

/**
 * The live runtime emits `{"status":{"state":"running"}}`. Reading
 * `record.status` as a string stringifies that object to "[object Object]",
 * which maps to `terminal` — every running session reported as a corpse. The
 * nested form is checked first for exactly that reason.
 */
export function recordState(record: ContainerRecord): string {
  const fromStatus = typeof record.status === 'object' ? record.status?.state : record.status;
  const fromState = typeof record.state === 'object' ? record.state?.status : record.state;
  return String(fromStatus ?? fromState ?? '').toLowerCase();
}

/**
 * Runtime state → seam phase. 'created' is prepared-not-started — an
 * adoption-adjacent incarnation, NOT a corpse; treating it as terminal would
 * have adoption tear down freshly-prepared sessions.
 */
export function appleStatePhase(state: string): SessionPhase {
  if (state === 'running' || state === 'paused' || state === 'restarting') return 'running';
  if (state === 'created' || state === 'starting') return 'starting';
  return 'terminal';
}

/**
 * 'standard' posture, Apple Container dialect.
 *
 * `--security-opt no-new-privileges` has no equivalent and is not faked: under
 * Docker it was depth against a root-in-container path on a SHARED kernel, and
 * here every container is its own VM. `--init` stays load-bearing for the same
 * reason it is under Docker — overriding the entrypoint defeats the image's
 * tini, and Linux discards default-action signals to PID 1, so without an init
 * every stop ends in SIGKILL after the full grace period.
 */
export function hardeningArgs(): string[] {
  return ['--cap-drop', 'ALL', '--init'];
}

/** Undefined stays unbounded, exactly as under Docker — the operator opts in. */
export function resourceArgs(spec: SessionSpec): string[] {
  const args: string[] = [];
  if (spec.resources.cpus) args.push('--cpus', spec.resources.cpus);
  if (spec.resources.memoryMb) args.push('--memory', `${spec.resources.memoryMb}m`);
  if (spec.resources.shmSizeMb) args.push('--shm-size', `${spec.resources.shmSizeMb}m`);
  return args;
}

/**
 * `--user` alone is not enough here: the Apple runtime resolves the process
 * identity from `--uid`/`--gid`, and a spec whose material is 0600 must be
 * read by the identity the spec named, not one inherited from the image.
 */
export function userArgs(spec: SessionSpec): string[] {
  if (!spec.runAs) return [];
  return [
    '--user',
    `${spec.runAs.uid}:${spec.runAs.gid}`,
    '--uid',
    String(spec.runAs.uid),
    '--gid',
    String(spec.runAs.gid),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String((error as { code: unknown }).code);
  return '';
}

export function isRuntimeUnavailable(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    errorCode(error) === 'ENOENT' ||
    /ENOENT|no such file|container system.*(not running|stopped)|system is not running|apiserver is not running|Ensure container system service has been started|daemon is not running|XPC connection error/i.test(
      message,
    )
  );
}

export function normalizeAppleContainerError(error: unknown): Error & SessionFailure {
  const message = errorMessage(error);
  if (isRuntimeUnavailable(error)) {
    return asFailureError({ kind: 'runtime-unavailable', retryable: true });
  }
  if (/manifest unknown|pull access denied|not found: manifest|No such image|image.*not found/i.test(message)) {
    return asFailureError({ kind: 'image-unavailable', retryable: true });
  }
  if (/no space left|cannot allocate memory/i.test(message)) {
    return asFailureError({ kind: 'resources-exhausted', retryable: true });
  }
  // Preserve the CLI's stderr. An opaque reference alone makes an Apple
  // Container realization failure impossible to diagnose from the logs.
  const failure = asFailureError({
    kind: 'unknown',
    retryable: false,
    opaqueRef: `apple-container-${Date.now()}`,
  });
  failure.message = `${failure.message}: ${message}`;
  return failure;
}
