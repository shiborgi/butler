/**
 * Registers the `apple-container` session driver. Appended to
 * `installed.ts` by the add-apple-container skill; selected with
 * `NANOCLAW_RUNTIME_DRIVER=apple-container`.
 *
 * Network realization lives here, beside the registration, exactly as
 * `dockerNetworkArgs` does for Docker: `spec.networkAccess` states the
 * destination, this realizes it, and no argv crosses the seam. Sessions run on
 * the install's host-only network and reach the gateway endpoint by name
 * through a per-session hosts file, because `container run` has no
 * `--add-host`.
 */
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

import { AppleContainerSessionDriver } from './apple-container-driver.js';
import {
  AppleEgressError,
  egressNetworkArgs,
  resolveEgressTarget,
  rewriteHostsFiles,
  writeHostsFile,
} from './apple-container-network.js';
import { agentContainerName } from './docker-driver.js';
import { registerSessionDriver } from './driver-registry.js';
import type { NetworkAccessIntent, SessionSpec } from './types.js';

export const APPLE_CONTAINER_DRIVER_KIND = 'apple-container';

/** One hosts file per session, named by its container. */
export const HOSTS_DIR = path.join(DATA_DIR, 'apple-container', 'hosts');

function routableTarget(access: NetworkAccessIntent): { kind: 'host' } | { kind: 'runtime'; identity: string } {
  if (access.target.kind === 'session-container') {
    // Auxiliary containers are refused at prepare (capabilities().auxiliaryContainers
    // is false), so a gateway that asks for one cannot be realized here.
    throw new AppleEgressError(
      `apple-container cannot route to a session-container gateway (role "${access.target.role}")`,
    );
  }
  return access.target;
}

function appleNetworkArgs(spec: SessionSpec): string[] {
  const access = spec.networkAccess;
  const address = resolveEgressTarget(routableTarget(access));
  const containerName = agentContainerName(spec);
  const hostsFile = writeHostsFile(HOSTS_DIR, containerName, access.endpoint, address);
  log.info('Session egress confined to host-only network', {
    containerName,
    endpoint: access.endpoint,
    address,
  });
  return [...egressNetworkArgs(), '-v', `${hostsFile}:/etc/hosts:ro`];
}

function reconcileAppleNetworkAccess(access: NetworkAccessIntent): void {
  const address = resolveEgressTarget(routableTarget(access));
  const rewritten = rewriteHostsFiles(HOSTS_DIR, access.endpoint, address);
  log.info('Session hosts files follow the gateway endpoint', { endpoint: access.endpoint, address, rewritten });
}

registerSessionDriver(
  APPLE_CONTAINER_DRIVER_KIND,
  (policy) =>
    new AppleContainerSessionDriver({
      ...policy,
      networkArgsFor: appleNetworkArgs,
      reconcileNetworkAccess: reconcileAppleNetworkAccess,
      fileStagingDir: path.join(DATA_DIR, 'apple-container', 'files'),
    }),
);
