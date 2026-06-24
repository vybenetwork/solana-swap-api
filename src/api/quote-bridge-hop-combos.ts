/**
 * Server-side filter for disabled multi-hop quote-bridge protocol pairs.
 * Env: DISABLED_QUOTE_BRIDGE_HOP_COMBOS=damm2-damm2,ammv4-ammv4
 */

import type { VybeSwapBuildResponse } from '../types/swap.js';
import { getDisabledQuoteBridgeHopCombos } from '../config.js';
import { isQuoteBridgeBuild, type QuoteBridgeBuildDetails } from './quote-bridge-detect.js';

type RoutePlanStepLike = {
  swapInfo?: { label?: string; provider?: string };
  label?: string;
  provider?: string;
};

/** Short hop key used in DISABLED_QUOTE_BRIDGE_HOP_COMBOS (e.g. meteora-damm2 → damm2). */
export function normalizeHopProtocolKey(raw: string): string {
  const k = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!k) return '';
  if (k.includes('damm2') || k === 'meteoradamm2') return 'damm2';
  if (k.includes('dlmm') || k === 'meteoradlmm') return 'dlmm';
  if (k.includes('dbc') || k === 'meteoradbc') return 'dbc';
  if (k.includes('ammv4') || k === 'raydiumammv4') return 'ammv4';
  if (k.includes('cpmm')) return 'cpmm';
  if (k.includes('clmm')) return 'clmm';
  if (k.includes('launchlab')) return 'launchlab';
  if (k.includes('pumpswap')) return 'pumpswap';
  if (k.includes('pumpfun')) return 'pumpfun';
  if (k.includes('sanctum')) return 'sanctum';
  return k.replace(/^meteora-/, '').replace(/^raydium-/, '');
}

function routePlanStepsFromBuild(build: VybeSwapBuildResponse): RoutePlanStepLike[] {
  const enrichment = build.enrichment as Record<string, unknown> | undefined;
  const details = build.details as unknown as Record<string, unknown> | undefined;
  const sources = [enrichment?.routePlan, build.routePlan, details?.routePlan];
  for (const raw of sources) {
    if (Array.isArray(raw) && raw.length > 0) {
      return raw as RoutePlanStepLike[];
    }
  }
  return [];
}

function hopLabelFromPlanStep(step: RoutePlanStepLike): string {
  const si = step.swapInfo;
  return String(si?.label ?? si?.provider ?? step.label ?? step.provider ?? '').trim();
}

/** Ordered hop protocol keys for quote-bridge / multi-hop builds. */
export function hopProtocolKeysFromBuild(build: VybeSwapBuildResponse): string[] {
  const fromPlan = routePlanStepsFromBuild(build)
    .map((step) => normalizeHopProtocolKey(hopLabelFromPlanStep(step)))
    .filter(Boolean);
  if (fromPlan.length >= 2) return fromPlan;

  if (!isQuoteBridgeBuild(build)) return fromPlan;

  const details = build.details as QuoteBridgeBuildDetails;
  const keys: string[] = [];
  const pre = details?.preSwapQuote as { provider?: string } | undefined;
  const main = details?.quote as { provider?: string } | undefined;
  const post = details?.postSwapQuote as { provider?: string } | undefined;
  if (pre?.provider) keys.push(normalizeHopProtocolKey(String(pre.provider)));
  if (main?.provider) keys.push(normalizeHopProtocolKey(String(main.provider)));
  else if (build.provider) keys.push(normalizeHopProtocolKey(String(build.provider)));
  if (post?.provider) keys.push(normalizeHopProtocolKey(String(post.provider)));
  return keys.filter(Boolean);
}

export function quoteBridgeHopComboKey(build: VybeSwapBuildResponse): string | null {
  if (!isQuoteBridgeBuild(build)) return null;
  const keys = hopProtocolKeysFromBuild(build);
  if (keys.length < 2) return null;
  return keys.join('-');
}

export function isQuoteBridgeHopComboDisabled(
  build: VybeSwapBuildResponse,
  disabled = getDisabledQuoteBridgeHopCombos(),
): boolean {
  if (disabled.size === 0) return false;
  const combo = quoteBridgeHopComboKey(build);
  if (!combo) return false;
  return disabled.has(combo);
}
