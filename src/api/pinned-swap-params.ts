/**
 * Vybe pinned swap: program id ↔ OpenAPI protocol name.
 * Pinned swaps accept poolAddress + programAddress and/or protocol; missing fields are derived.
 */

import type { SwapProxyProtocol } from './swap-build.js';

export const IX_BUILDER_SUPPORTED_PROGRAMS: Record<
  string,
  { protocol: SwapProxyProtocol; ixBuilderProtocol: string; label: string }
> = {
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN': {
    protocol: 'METEORADBC',
    ixBuilderProtocol: 'METEORA_DBC',
    label: 'Meteora DBC',
  },
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': {
    protocol: 'METEORADAMM2',
    ixBuilderProtocol: 'METEORA_DAMM2',
    label: 'Meteora DAMM v2',
  },
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': {
    protocol: 'METEORADLMM',
    ixBuilderProtocol: 'METEORA_DLMM',
    label: 'Meteora DLMM',
  },
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': {
    protocol: 'RAYDIUMLAUNCHLAB',
    ixBuilderProtocol: 'RAYDIUM_LAUNCHLAB',
    label: 'Raydium LaunchLab',
  },
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': {
    protocol: 'RAYDIUMAMMV4',
    ixBuilderProtocol: 'RAYDIUM_AMM_V4',
    label: 'Raydium AMM v4',
  },
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': {
    protocol: 'RAYDIUMCPMM',
    ixBuilderProtocol: 'RAYDIUM_CPMM',
    label: 'Raydium CPMM',
  },
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': {
    protocol: 'RAYDIUMCLMM',
    ixBuilderProtocol: 'RAYDIUM_CLMM',
    label: 'Raydium CLMM',
  },
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': {
    protocol: 'PUMPFUN',
    ixBuilderProtocol: 'PUMPFUN',
    label: 'Pump.fun',
  },
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': {
    protocol: 'PUMPSWAP',
    ixBuilderProtocol: 'PUMPSWAP',
    label: 'PumpSwap',
  },
  '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx': {
    protocol: 'SANCTUM',
    ixBuilderProtocol: 'SANCTUM',
    label: 'Sanctum',
  },
};

const PROTOCOL_TO_PROGRAM = Object.fromEntries(
  Object.entries(IX_BUILDER_SUPPORTED_PROGRAMS).map(([programId, meta]) => [meta.protocol, programId]),
) as Record<SwapProxyProtocol, string>;

export const IX_BUILDER_PROGRAM_IDS = Object.keys(IX_BUILDER_SUPPORTED_PROGRAMS);

export function programAddressToProtocol(programAddress: string): SwapProxyProtocol | undefined {
  return IX_BUILDER_SUPPORTED_PROGRAMS[programAddress.trim()]?.protocol;
}

export function programAddressToIxBuilderProtocol(programAddress: string): string | undefined {
  return IX_BUILDER_SUPPORTED_PROGRAMS[programAddress.trim()]?.ixBuilderProtocol;
}

export function protocolToProgramAddress(protocol: SwapProxyProtocol): string | undefined {
  return PROTOCOL_TO_PROGRAM[protocol];
}

export function programLabelForAddress(programAddress: string): string {
  const addr = programAddress.trim();
  if (!addr) return '';
  return IX_BUILDER_SUPPORTED_PROGRAMS[addr]?.label ?? addr;
}

export function isSupportedIxBuilderProgram(programAddress: string): boolean {
  return programAddress.trim() in IX_BUILDER_SUPPORTED_PROGRAMS;
}

/** Fill missing protocol or programAddress when a pool pin is partially specified. */
export function completePinnedSwapParams<T extends {
  poolAddress?: string;
  protocol?: SwapProxyProtocol;
  programAddress?: string;
}>(params: T): T {
  const poolAddress = params.poolAddress?.trim();
  if (!poolAddress) return params;

  let protocol = params.protocol;
  let programAddress = params.programAddress?.trim();

  if (programAddress && !protocol) {
    protocol = programAddressToProtocol(programAddress);
  }
  if (protocol && !programAddress) {
    programAddress = protocolToProgramAddress(protocol);
  }

  if (!protocol && !programAddress) return params;

  return {
    ...params,
    poolAddress,
    ...(protocol ? { protocol } : {}),
    ...(programAddress ? { programAddress } : {}),
  };
}
