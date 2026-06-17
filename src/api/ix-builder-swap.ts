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
import { appendAtaHintsToPayload } from './wallet-ata-hints.js';
import { completePinnedSwapParams } from './pinned-swap-params.js';
import type { BuildSwapParams } from './swap-build.js';
import { resolveEnumerateRoutes } from './swap-build.js';

export function mapBuildSwapParamsToIxBuilder(body: BuildSwapParams): Record<string, unknown> {
  const pinned = completePinnedSwapParams(body);
  const router = body.router ?? 'vybe';
  const payload: Record<string, unknown> = {
    wallet: pinned.accountAddress.trim(),
    inputMint: pinned.inputMintAddress.trim(),
    outputMint: pinned.outputMintAddress.trim(),
    amount: pinned.amount,
    router,
  };
  if (router === 'vybe') {
    payload.vybeOnly = true;
  }

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
  // ix-builder owns simulation + fee/USD/% enrichment; always request the print-ready payload.
  payload.enrich = true;

  const feePct =
    pinned.swapFee != null && Number.isFinite(pinned.swapFee)
      ? pinned.swapFee
      : DEFAULT_SWAP_SERVICE_FEE_PCT;
  if (feePct > 0) payload.fee = feePct;

  appendAtaHintsToPayload(payload, {
    closeInputAta: pinned.closeInputAta,
    createOutputAta: pinned.createOutputAta,
    closeWsolAta: pinned.closeWsolAta,
  });
  if (pinned.inputBalanceExact?.trim()) {
    payload.inputBalanceExact = pinned.inputBalanceExact.trim();
  }
  if (pinned.inputDecimals != null && Number.isFinite(pinned.inputDecimals)) {
    payload.inputDecimals = pinned.inputDecimals;
  }
  if (body.marketFetchMode) payload.marketFetchMode = body.marketFetchMode;
  if (router === 'vybe') {
    payload.enumerateRoutes = resolveEnumerateRoutes(body);
  }

  return payload;
}

type IxBuilderSwapErrorBody = {
  error?: string;
  details?: string;
  detail?: string;
};

/** ix-builder returns { error, details } on failure — often with HTTP 500. */
export function ixBuilderSwapErrorMessage(err: unknown): string | undefined {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as IxBuilderSwapErrorBody | undefined;
    if (body && typeof body === 'object') {
      const msg = (body.details ?? body.detail ?? '').trim();
      if (msg) return msg;
      if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
    }
  }
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return undefined;
}

function assertIxBuilderSwapResponse(
  data: (VybeSwapBuildResponse & IxBuilderSwapErrorBody) | undefined,
): VybeSwapBuildResponse {
  if (data && typeof data === 'object' && data.error) {
    const msg = (data.details ?? data.detail ?? String(data.error)).trim();
    throw new Error(msg || 'ix-builder swap failed');
  }
  if (!data?.tx && !data?.transaction) {
    throw new Error('ix-builder swap response missing transaction');
  }
  return data;
}

export async function buildSwapViaIxBuilder(body: BuildSwapParams): Promise<VybeSwapBuildResponse> {
  const payload = mapBuildSwapParamsToIxBuilder(body);
  try {
    const { data } = await axios.post<VybeSwapBuildResponse & IxBuilderSwapErrorBody>(
      `${IX_BUILDER_LOCAL_URL}/swap`,
      payload,
      {
        timeout: VYBE_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
        validateStatus: (status) => status < 500 || status === 500,
      },
    );
    return assertIxBuilderSwapResponse(data);
  } catch (err) {
    const msg = ixBuilderSwapErrorMessage(err);
    if (msg) throw new Error(msg);
    throw err;
  }
}
