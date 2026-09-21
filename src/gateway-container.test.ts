import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureGatewayImage,
  gatewayImageTag,
  gatewaySourceRevision,
  type GatewayContainerRecord,
} from './gateway-container.js';
import type { Cli, SupervisedProcess } from './drivers/cli.js';

const roots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-gateway-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'gateway', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'gateway', 'Dockerfile'), 'COPY src ./src\n');
  fs.writeFileSync(path.join(root, 'gateway', 'package.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'gateway', 'tsconfig.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'gateway', 'src', 'index.ts'), 'export const version = 1;\n');
  return root;
}

function fakeCli(imageExists = false): { cli: Cli; calls: string[][] } {
  const calls: string[][] = [];
  const cli: Cli = {
    bin: 'container',
    run(args) {
      calls.push(args);
      if (args[0] === 'image' && !imageExists) throw new Error('not found');
      return '';
    },
    start(): SupervisedProcess {
      throw new Error('unused');
    },
  };
  return { cli, calls };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('gateway image revision', () => {
  it('changes the image identity whenever image source changes', () => {
    const root = fixture();
    const before = gatewayImageTag(root);
    fs.writeFileSync(path.join(root, 'gateway', 'src', 'index.ts'), 'export const version = 2;\n');
    expect(gatewayImageTag(root)).not.toBe(before);
  });

  it('does not read runtime config or secrets into the image identity', () => {
    const root = fixture();
    const before = gatewaySourceRevision(root);
    fs.mkdirSync(path.join(root, 'gateway', 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'gateway', 'config', 'secret.json'), '{"token":"changed"}');
    expect(gatewaySourceRevision(root)).toBe(before);
  });

  it('builds the content-addressed image when it is absent', () => {
    const root = fixture();
    const { cli, calls } = fakeCli(false);
    ensureGatewayImage(cli, root);
    expect(calls[0].slice(0, 2)).toEqual(['image', 'inspect']);
    expect(calls[1]).toEqual(['build', '-t', gatewayImageTag(root), path.join(root, 'gateway')]);
  });

  it('keeps the runtime record shape used for revision labels type-safe', () => {
    const record: GatewayContainerRecord = {
      configuration: { labels: { 'nanoclaw-gateway-revision': 'abc' } },
    };
    expect(record.configuration?.labels?.['nanoclaw-gateway-revision']).toBe('abc');
  });
});
