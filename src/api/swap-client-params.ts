/**
 * Client-supplied swap leg hints (frontend → Vybe → ix-builder).
 * Replaces the tokenHints map for swap/quote build requests.
 */

export interface SwapClientParams {
  inputMintPrice?: number;
  outputMintPrice?: number;
  solPrice?: number;
  inputMintDecimals?: number;
  outputMintDecimals?: number;
}

function parsePositiveUsdPrice(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseMintDecimals(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 255) return undefined;
  return Math.trunc(n);
}

export function parseSwapClientParams(body: Record<string, unknown>): SwapClientParams {
  const inputMintDecimals =
    parseMintDecimals(body.inputMintDecimals) ?? parseMintDecimals(body.inputDecimals);
  return {
    inputMintPrice: parsePositiveUsdPrice(body.inputMintPrice),
    outputMintPrice: parsePositiveUsdPrice(body.outputMintPrice),
    solPrice: parsePositiveUsdPrice(body.solPrice),
    inputMintDecimals,
    outputMintDecimals: parseMintDecimals(body.outputMintDecimals),
  };
}

export function appendSwapClientParamsToPayload(
  payload: Record<string, unknown>,
  params: SwapClientParams,
): void {
  if (params.inputMintPrice != null) payload.inputMintPrice = params.inputMintPrice;
  if (params.outputMintPrice != null) payload.outputMintPrice = params.outputMintPrice;
  if (params.solPrice != null) payload.solPrice = params.solPrice;
  if (params.inputMintDecimals != null) payload.inputMintDecimals = params.inputMintDecimals;
  if (params.outputMintDecimals != null) payload.outputMintDecimals = params.outputMintDecimals;
}

/** Ephemeral hints for swap-api server-side price resolve (not forwarded to Vybe). */
export function clientParamsToPriceResolveHints(
  params: SwapClientParams,
  inputMint: string,
  outputMint: string,
): Record<string, { price?: number; decimals?: number }> {
  const hints: Record<string, { price?: number; decimals?: number }> = {};
  const inKey = inputMint.trim();
  const outKey = outputMint.trim();
  if (inKey && (params.inputMintPrice != null || params.inputMintDecimals != null)) {
    hints[inKey] = {
      ...(params.inputMintPrice != null ? { price: params.inputMintPrice } : {}),
      ...(params.inputMintDecimals != null ? { decimals: params.inputMintDecimals } : {}),
    };
  }
  if (outKey && (params.outputMintPrice != null || params.outputMintDecimals != null)) {
    hints[outKey] = {
      ...(params.outputMintPrice != null ? { price: params.outputMintPrice } : {}),
      ...(params.outputMintDecimals != null ? { decimals: params.outputMintDecimals } : {}),
    };
  }
  return hints;
}
