import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../log.js';
import { installLibsignalLogGuard, libsignalMessage } from './whatsapp-log-guard.js';

function fakeConsole() {
  const calls: unknown[][] = [];
  const record = (...args: unknown[]) => calls.push(args);
  const target = { log: record, info: record, warn: record, error: record } as unknown as Console;
  installLibsignalLogGuard(target);
  return { target, calls };
}

const session = { currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from('secret-key-material') } } };

describe('libsignal log guard', () => {
  it('re-logs a session change as text and never passes the session on', () => {
    const { target, calls } = fakeConsole();
    target.info('Closing session:', session);

    expect(calls).toEqual([]);
    expect(log.debug).toHaveBeenCalledWith('Closing session:', { source: 'libsignal' });
    expect(JSON.stringify(vi.mocked(log.debug).mock.calls)).not.toContain('privKey');
  });

  it('keeps decrypt failures visible as warnings, without the stack argument', () => {
    const { target, calls } = fakeConsole();
    target.error('Session error:Error: Bad MAC', 'stack...');

    expect(calls).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('Session error:Error: Bad MAC', { source: 'libsignal' });
  });

  it('leaves every other console call alone', () => {
    const { target, calls } = fakeConsole();
    target.info('Closing time', session);
    target.log({ not: 'a string' });

    expect(calls).toEqual([['Closing time', session], [{ not: 'a string' }]]);
  });

  it('installs once, so a second import does not wrap twice', () => {
    const { target, calls } = fakeConsole();
    installLibsignalLogGuard(target);
    target.warn('plain');
    expect(calls).toEqual([['plain']]);
  });

  it('matches only from the start of the message', () => {
    expect(libsignalMessage(['user said: Closing session:'])).toBeNull();
    expect(libsignalMessage(['Opening session:', session])?.level).toBe('debug');
  });
});
