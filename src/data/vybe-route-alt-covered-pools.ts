/**
 * Pools packed into Vybe route CLMM/DLMM address lookup tables (ix-builder).
 * Source of truth: ix-builder-api-main-nodejs/src/data/vybe-route-{clmm,dlmm}-pools.js
 * On-chain ALTs:
 *   CLMM → Gbs4Hdi5HzM6XCWg3NNdXJWvxANUDgRPX9AEmKZ5cs2d
 *   DLMM → Dspc41Qi68JYH6UMUqiJB4BGooBXDqj2W8AhpbL27gwX
 */

export const VYBE_ROUTE_CLMM_ALT_ADDRESS = 'Gbs4Hdi5HzM6XCWg3NNdXJWvxANUDgRPX9AEmKZ5cs2d';
export const VYBE_ROUTE_DLMM_ALT_ADDRESS = 'Dspc41Qi68JYH6UMUqiJB4BGooBXDqj2W8AhpbL27gwX';

/** Recently extended CLMM quote-bridge legs (USDT–USDG, USDG–ONyc). */
export const VYBE_ROUTE_CLMM_ALT_COVERED_POOLS = [
  {
    address: 'ExwyJ1D3F4RwaRvpGhmendPFK7Jfiqjh7a1TcQzt4Sq',
    mintA: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    mintB: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
    label: 'USDT/USDG',
  },
  {
    address: 'A9RdNEf4T9x1eNPnEHFX1ABHS7J4e9kxBm43S3o5r9Kw',
    mintA: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
    mintB: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5',
    label: 'USDG/ONyc',
  },
] as const;

/** Recently extended DLMM quote-bridge legs (USDT–ANTFUN). */
export const VYBE_ROUTE_DLMM_ALT_COVERED_POOLS = [
  {
    address: '54Vp27uLaw4wNLo5n7r4fcC6zLamoQc28xBARjss4EUJ',
    mintX: 'CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt',
    mintY: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    label: 'ANTFUN/USDT',
  },
] as const;

export const VYBE_ROUTE_CLMM_ALT_COVERED_POOL_SET = new Set(
  VYBE_ROUTE_CLMM_ALT_COVERED_POOLS.map((p) => p.address),
);

export const VYBE_ROUTE_DLMM_ALT_COVERED_POOL_SET = new Set(
  VYBE_ROUTE_DLMM_ALT_COVERED_POOLS.map((p) => p.address),
);
