/**
 * Local ix-builder POST /swap — used when VYBE_API_LOCATION=local.
 */

import axios from 'axios';
import {
  DEFAULT_SWAP_SERVICE_FEE_PCT,
  IX_BUILDER_LOCAL_URL,
  VYBE_TIMEOUT_MS,
} from '../config.js';
import type { VybeSwapBuildResponse } from '../types/swap.js';
import { withRetry } from './client.js';
import { completePinnedSwapParams } from './pinned-swap-params.js';
import type { BuildSwapParams } from './swap-build.js';

export function mapBuildSwapParamsToIxBuilder(body: BuildSwapParams): Record<string, unknown> {
  const pinned = completePinnedSwapParams(body);
  const payload: Record<string, unknown> = {
    wallet: pinned.accountAddress.trim(),
    inputMint: pinned.inputMintAddress.trim(),
    outputMint: pinned.outputMintAddress.trim(),
    amount: pinned.amount,
    router: 'vybe',
    vybeOnly: true,
  };

  if (pinned.slippage != null && Number.isFinite(pinned.slippage)) {
    payload.slippage = pinned.slippage;
  }
  if (pinned.autoCalculateSlippage != null) {
    payload.autoCalculateSlippage = pinned.autoCalculateSlippage;
  }
  if (pinned.gasless != null) payload.gasless = pinned.gasless;
  if (pinned.partner?.trim()) payload.partner = pinned.partner.trim();
  if (pinned.poolAddress?.trim()) payload.poolAddress = pinned.poolAddress.trim();
  if (pinned.protocol) payload.protocol = pinned.protocol;
  if (pinned.programAddress?.trim()) payload.programAddress = pinned.programAddress.trim();
  if (pinned.simulate != null) payload.simulate = pinned.simulate;

  const feePct =
    pinned.swapFee != null && Number.isFinite(pinned.swapFee)
      ? pinned.swapFee
      : DEFAULT_SWAP_SERVICE_FEE_PCT;
  if (feePct > 0) payload.fee = feePct;

  return payload;
}

type IxBuilderSwapErrorBody = {
  error?: string;
  details?: string;
  detail?: string;
};

export async function buildSwapViaIxBuilder(body: BuildSwapParams): Promise<VybeSwapBuildResponse> {
  const payload = mapBuildSwapParamsToIxBuilder(body);
  return withRetry(async () => {
    const { data } = await axios.post<VybeSwapBuildResponse & IxBuilderSwapErrorBody>(
      `${IX_BUILDER_LOCAL_URL}/swap`,
      payload,
      {
        timeout: VYBE_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
      },
    );

    if (data && typeof data === 'object' && data.error) {
      const msg = data.details ?? data.detail ?? String(data.error);
      throw new Error(msg);
    }
    if (!data?.tx && !data?.transaction) {
      throw new Error('ix-builder swap response missing transaction');
    }
    return data;
  });
}
