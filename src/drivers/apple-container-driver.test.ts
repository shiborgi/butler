/**
 * Apple Container driver — realization fidelity against a fake `container` CLI.
 *
 * These assert what the driver DID, not what its source looks like: the argv it
 * built, the mounts it bound, the absence of flags this runtime does not have,
 * and the label-only adoption contract. The shared conformance floor
 * (`conformance.test.ts`) covers the semantics every driver owes; this file
 * covers the dialect only this one has.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppleContainerSessionDriver,
  appleStatePhase,
  isRuntimeUnavailable,
  normalizeAppleContainerError,
  parseContainerRecords,
  recordLabels,
  recordName,
  recordState,
} from './apple-container-driver.js';
import { FakeCli } from './fake-cli.js';
import { FIXTURE_POLICY, fixtureSpec, fixtureSpecWithAux } from './spec-fixture.js';
import { LABELS, type SessionEvent } from './types.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// The driver re-checks that mount sources exist; fixture paths are not real files.
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => true) } }));

import fs from 'fs';

import { log } from '../log.js';

let cli: FakeCli;

function driver(networkArgsFor?: () => string[]): AppleContainerSessionDriver {
  return new AppleContainerSessionDriver({ ...FIXTURE_POLICY, cli, networkArgsFor });
}

function createArgs(): string[] {
  const call = cli.callMatching(/^create /);
  expect(call, 'expected a `container create` call').toBeDefined();
  return call!.args;
}

beforeEach(() => {
  vi.clearAllMocks();
  cli = new FakeCli('container');
  // No such container: `inspect` returns an empty document set.
  cli.responses = [{ match: /^inspect /, output: '[]' }];
});

describe('create argv', () => {
  it('realizes hardening, resources and identity in the Apple dialect', async () => {
    await driver().prepare(fixtureSpec());
    const args = createArgs();
    const joined = args.join(' ');

    expect(args.slice(0, 4)).toEqual(['create', '--rm', '--name', 'ncl-spike-s1']);
    expect(joined).toContain('--cap-drop ALL');
    expect(args).toContain('--init');
    expect(joined).toContain('--shm-size 1024m');
    // Apple resolves process identity from --uid/--gid, not --user alone.
    expect(joined).toContain('--user 501:1000');
    expect(joined).toContain('--uid 501');
    expect(joined).toContain('--gid 1000');
    expect(cli.bin).toBe('container');
  });

  it('never emits flags this runtime does not have', async () => {
    await driver().prepare(fixtureSpec());
    const joined = createArgs().join(' ');
    // pidsLimit is 2048 on the fixture and is declared `unrealized` — a driver
    // that silently emitted it would fail at runtime instead of degrading honestly.
    expect(joined).not.toContain('--pids-limit');
    expect(joined).not.toContain('security-opt');
    expect(joined).not.toContain('--add-host');
  });

  it('declares pidsLimit unrealized rather than faking it', () => {
    const caps = driver().capabilities();
    expect(caps.unrealized).toContain('pidsLimit');
    expect(caps.isolationTiers).toContain('container');
    expect(caps.auxiliaryContainers).toBe(false);
    expect(caps.imageBuild).toBe(true);
  });

  it('binds every mount, files included, preserving read-only intent', async () => {
    await driver().prepare(fixtureSpec());
    const args = createArgs();
    // Directory mount, read-write.
    expect(args).toContain('/install/data/v2-sessions/g1/s1:/workspace');
    // Directory mount, read-only.
    expect(args).toContain('/install/container/agent-runner/src:/app/src:ro');
    // Single FILE mount: `-v` binds it here, so it must not be dropped. The
    // real install mounts the session descriptor and the composed instruction
    // document this way, and losing them degrades the agent silently.
    expect(args).toContain('/install/container/CLAUDE.md:/app/CLAUDE.md:ro');
  });

  it('lets the contributed lane override composed env', async () => {
    const base = fixtureSpec();
    const spec = fixtureSpec({
      containers: [{ ...base.containers[0], contributedEnv: { HTTPS_PROXY: 'http://gateway:8080' } }],
    });
    await driver().prepare(spec);
    const emitted = createArgs();
    const proxyFlags = emitted.filter((a) => a.startsWith('HTTPS_PROXY='));
    // Composed first, contributed second — last wins, as the seam contracts.
    expect(proxyFlags).toEqual(['HTTPS_PROXY=http://127.0.0.1:15001', 'HTTPS_PROXY=http://gateway:8080']);
  });

  it('uses the injected network seam and never shells another runtime', async () => {
    await driver(() => ['--network', 'nanoclaw-egress-v2-abc']).prepare(fixtureSpec());
    const args = createArgs();
    expect(args).toContain('--network');
    expect(args).toContain('nanoclaw-egress-v2-abc');
  });

  it('realizes network none explicitly rather than inheriting a default', async () => {
    await driver(() => ['--network', 'should-not-be-used']).prepare(fixtureSpec({ network: 'none' }));
    const args = createArgs();
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).not.toContain('should-not-be-used');
  });

  it('refuses a spec carrying auxiliary containers instead of realizing a subset', async () => {
    await expect(driver().prepare(fixtureSpecWithAux())).rejects.toMatchObject({ kind: 'spec-invalid' });
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });

  it('refuses a missing mount source before create', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'spec-invalid', retryable: false });
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });

  it('leaves nothing behind when create fails', async () => {
    cli.responses = [
      { match: /^inspect /, output: '[]' },
      { match: /^create /, throws: new Error('boom') },
    ];
    await expect(driver().prepare(fixtureSpec())).rejects.toThrow();
    expect(cli.joined().some((c) => c.startsWith('rm --force ncl-spike-s1'))).toBe(true);
  });
});

describe('adoption', () => {
  const listing = JSON.stringify([
    {
      configuration: {
        id: 'ncl-spike-s1',
        labels: {
          [LABELS.install]: 'spike',
          [LABELS.role]: 'agent',
          [LABELS.group]: 'g1',
          [LABELS.session]: 's1',
        },
      },
      status: { state: 'running' },
    },
    {
      configuration: {
        id: 'ncl-other-s9',
        labels: {
          [LABELS.install]: 'a-different-install',
          [LABELS.role]: 'agent',
          [LABELS.group]: 'g9',
          [LABELS.session]: 's9',
        },
      },
      status: { state: 'running' },
    },
  ]);

  it('reconstructs handles from labels alone and ignores other installs', async () => {
    cli.responses = [{ match: /^list /, output: listing }];
    const snapshots = await driver().listSessions('spike');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].handle.key).toEqual({ installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' });
    expect(snapshots[0].phase).toBe('running');
  });

  it('is idempotent on key: an existing labelled container is the session', async () => {
    cli.responses = [
      {
        match: /^inspect /,
        output: JSON.stringify([
          {
            configuration: {
              id: 'ncl-spike-s1',
              labels: {
                [LABELS.install]: 'spike',
                [LABELS.group]: 'g1',
                [LABELS.session]: 's1',
              },
            },
            status: { state: 'running' },
          },
        ]),
      },
    ];
    await driver().prepare(fixtureSpec());
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });

  it('refuses a name collision with a container that is not this session', async () => {
    cli.responses = [
      {
        match: /^inspect /,
        output: JSON.stringify([
          {
            configuration: {
              id: 'ncl-spike-s1',
              labels: {
                [LABELS.install]: 'somebody-else',
                [LABELS.group]: 'gX',
                [LABELS.session]: 'sX',
              },
            },
            status: { state: 'running' },
          },
        ]),
      },
    ];
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'unknown', retryable: false });
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });
});

describe('watchSessions', () => {
  it('does not report a live container terminal when only the attach helper fails', async () => {
    vi.useFakeTimers();
    try {
      const events: SessionEvent[] = [];
      const d = driver();
      const handle = await d.prepare(fixtureSpec());
      const watch = d.watchSessions('spike', (event) => events.push(event));
      await handle.start();

      cli.started[0].proc.emitExit(null);

      expect(events).toEqual([]);
      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls the listing and reports a vanished session as terminal', async () => {
    vi.useFakeTimers();
    try {
      const events: SessionEvent[] = [];
      const present = JSON.stringify([
        {
          configuration: {
            id: 'ncl-spike-s1',
            labels: {
              [LABELS.install]: 'spike',
              [LABELS.role]: 'agent',
              [LABELS.group]: 'g1',
              [LABELS.session]: 's1',
            },
          },
          status: { state: 'running' },
        },
      ]);
      cli.responses = [{ match: /^list /, output: present }];
      const d = driver();
      d.watchSessions('spike', (e) => events.push(e));

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_100);
      // `--rm` removes the container on exit, so it simply stops being listed.
      cli.responses = [{ match: /^list /, output: '[]' }];
      await vi.advanceTimersByTimeAsync(1_100);

      expect(events.some((e) => e.kind === 'terminal')).toBe(true);
      expect(cli.joined().filter((c) => c.startsWith('list --all --format json')).length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a failed listing as a gap, never as a mass terminal', async () => {
    vi.useFakeTimers();
    try {
      const events: SessionEvent[] = [];
      cli.responses = [{ match: /^list /, throws: new Error('XPC connection error') }];
      driver().watchSessions('spike', (e) => events.push(e));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('status while a container is starting', () => {
  /*
   * Apple Container lists a created container, and one whose start is still
   * in flight, as `stopped`. A listing poll in that window used to read as a
   * dead session: the host killed it and respawned, up to three times.
   */
  const stopped = () => [{ match: /^inspect /, output: JSON.stringify([{ status: { state: 'stopped' } }]) }];

  it('reads a prepared container the runtime lists as stopped as ready', async () => {
    const handle = await driver().prepare(fixtureSpec());
    cli.responses = stopped();
    expect((await handle.status()).phase).toBe('ready');
  });

  it('reads a started container as running while its attach is alive', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    cli.responses = stopped();
    expect((await handle.status()).phase).toBe('running');
  });

  it('reads it as ended once the attach has exited', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    cli.started[0].proc.emitExit(0);
    cli.responses = stopped();
    expect((await handle.status()).phase).toBe('stopped');
  });
});

describe('early exit diagnosis', () => {
  /*
   * A session whose attach ends right after start is respawned by the host;
   * this line is the only record of why, so it carries the state and stderr.
   */
  it('records how a container that ended right after start went', async () => {
    const d = driver();
    const handle = await d.prepare(fixtureSpec());
    d.watchSessions('spike', () => {});
    await handle.start();
    cli.responses = [{ match: /^inspect /, output: '[]' }];
    const proc = cli.started[0].proc;
    proc.emitStderr('[agent-runner] boom');
    proc.emitExit(0);

    expect(log.warn).toHaveBeenCalledWith(
      'Container ended shortly after start',
      expect.objectContaining({ code: 0, state: 'absent', stderrTail: ['[agent-runner] boom'] }),
    );
  });

  it('names an early stop the host decided on, with what the runtime showed', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    cli.responses = [{ match: /^inspect /, output: JSON.stringify([{ status: { state: 'stopped' } }]) }];
    await handle.stop('runtime-ended');

    expect(log.warn).toHaveBeenCalledWith(
      'Session container stopped shortly after start',
      expect.objectContaining({ reason: 'runtime-ended', state: 'stopped' }),
    );
  });

  it('stays quiet when the host stopped the container itself', async () => {
    const d = driver();
    const handle = await d.prepare(fixtureSpec());
    await handle.start();
    await handle.stop('test');
    cli.started[0].proc.emitExit(0);

    expect(log.warn).not.toHaveBeenCalledWith('Container ended shortly after start', expect.anything());
  });

  it('stays quiet for a session that ran its course', async () => {
    vi.useFakeTimers();
    try {
      const d = driver();
      const handle = await d.prepare(fixtureSpec());
      await handle.start();
      vi.advanceTimersByTime(60_000);
      cli.started[0].proc.emitExit(0);
      expect(log.warn).not.toHaveBeenCalledWith('Container ended shortly after start', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('failure taxonomy', () => {
  it('maps a missing CLI to runtime-unavailable', () => {
    const err = Object.assign(new Error('spawn container ENOENT'), { code: 'ENOENT' });
    expect(isRuntimeUnavailable(err)).toBe(true);
    expect(normalizeAppleContainerError(err)).toMatchObject({ kind: 'runtime-unavailable', retryable: true });
  });

  it('maps a stopped container system to runtime-unavailable in ensureReady', async () => {
    cli.responses = [{ match: /^system status/, throws: new Error('apiserver is not running') }];
    await expect(driver().ensureReady()).rejects.toMatchObject({ kind: 'runtime-unavailable', retryable: true });
  });

  it('maps a missing image to image-unavailable', () => {
    expect(normalizeAppleContainerError(new Error('No such image: nanoclaw-agent'))).toMatchObject({
      kind: 'image-unavailable',
      retryable: true,
    });
  });

  it('keeps the runtime stderr on an unknown failure so it can be diagnosed', () => {
    const failure = normalizeAppleContainerError(new Error('some novel apple failure'));
    expect(failure.kind).toBe('unknown');
    expect(failure.message).toContain('some novel apple failure');
  });
});

describe('document parsing', () => {
  it('accepts array, single-object and NDJSON shapes', () => {
    expect(parseContainerRecords('[{"id":"a"}]')).toHaveLength(1);
    expect(parseContainerRecords('{"id":"a"}')).toHaveLength(1);
    expect(parseContainerRecords('{"id":"a"}\n{"id":"b"}')).toHaveLength(2);
    expect(parseContainerRecords('   ')).toEqual([]);
  });

  it('reads labels, name and state from configuration-shaped documents', () => {
    const record = parseContainerRecords(
      JSON.stringify([{ configuration: { id: 'ncl-x', labels: { a: 'b' } }, status: { state: 'RUNNING' } }]),
    )[0];
    expect(recordLabels(record)).toEqual({ a: 'b' });
    expect(recordName(record)).toBe('ncl-x');
    expect(recordState(record)).toBe('running');
  });

  it('maps created to starting so adoption does not reap a prepared session', () => {
    expect(appleStatePhase('created')).toBe('starting');
    expect(appleStatePhase('running')).toBe('running');
    expect(appleStatePhase('stopped')).toBe('terminal');
    expect(appleStatePhase('')).toBe('terminal');
  });
});
