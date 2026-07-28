/**
 * Built-in detector registration.
 *
 * Adding a detector is one new file plus one entry here (NFR-5.4). Nothing in the
 * pipeline changes.
 */

import { DetectorRegistry } from './registry.js';
import { L0_AGENT_DETECTORS } from './deterministic/l0-agent.js';
import { L0_INFRASTRUCTURE_DETECTORS } from './deterministic/l0-infrastructure.js';
import { L0_TOOL_DETECTORS } from './deterministic/l0-tool.js';
import { L1_CONTEXT_DETECTORS } from './deterministic/l1-context.js';
import { L1_GENERATION_DETECTORS } from './deterministic/l1-generation.js';
import { L1_SECURITY_DETECTORS } from './deterministic/l1-security.js';
import { L2_DETECTORS } from './statistical/l2-baselines.js';
import { L3_DETECTORS } from './judge/l3-semantic.js';
import type { Detector } from './types.js';

export { DetectorRegistry } from './registry.js';
export { runSandboxed } from './sandbox.js';
export type { SandboxOptions, SandboxResult } from './sandbox.js';
export { evidence, finding } from './types.js';
export type { BaselineReader, CostClass, DetectionContext, Detector } from './types.js';
export { createJudge } from './judge/provider.js';
export type { JudgeProvider, JudgeRequest, JudgeVerdict } from './judge/provider.js';

export const BUILTIN_DETECTORS: readonly Detector[] = [
  ...L0_INFRASTRUCTURE_DETECTORS,
  ...L0_AGENT_DETECTORS,
  ...L0_TOOL_DETECTORS,
  ...L1_GENERATION_DETECTORS,
  ...L1_CONTEXT_DETECTORS,
  ...L1_SECURITY_DETECTORS,
  ...L2_DETECTORS,
  ...L3_DETECTORS,
];

export function createRegistry(extra: readonly Detector[] = []): DetectorRegistry {
  const registry = new DetectorRegistry();
  registry.registerAll(BUILTIN_DETECTORS);
  registry.registerAll(extra);
  return registry;
}
