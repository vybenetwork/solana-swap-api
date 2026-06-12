# DATA-2515: Vybe API pinned swap params incomplete unless all three fields sent

**Component:** Vybe API `POST /v4/trading/swap` (ix-builder proxy)  
**Severity:** Medium — pinned direct builds fail or route to wrong DEX unless callers send the full pin set  
**Status:** Open (gateway / API layer)  
**Workaround:** Always send `poolAddress`, `programAddress`, and `protocol` together on Vybe router builds  

## Summary

After ix-builder pinned-swap support shipped (`program-protocol.js`), local ix-builder `/swap` accepts any of:

- `poolAddress` + `programAddress`
- `poolAddress` + `protocol` (`METEORADLMM`, etc.)
- all three

Production **Vybe API** (`https://api.vybenetwork.xyz/v4/trading/swap`) behaves differently: only the **all-three** combination reliably produces a direct protocol build (e.g. Meteora DLMM). Sending two of three fields falls through to unpinned routing (DAMM2 / Jupiter).

## Reproduction

Wallet: `7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza`  
Pair: SOL → BONK, amount `0.01`, `router: "vybe"`

Pool: `6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp`  
Program: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`  
Protocol: `METEORADLMM`

| Request params | Provider returned | DLMM pool/program in tx |
|----------------|-------------------|-------------------------|
| `poolAddress` + `programAddress` | `meteora-damm2` | No |
| `poolAddress` + `protocol` | `jupiter` | No |
| `poolAddress` + `programAddress` + `protocol` | `Meteora DLMM` | Yes |

Local ix-builder (same pins, `/swap` endpoint): **all three scenarios pass**.

## Expected

Any valid two-of-three pin combo accepted by ix-builder should work through Vybe API v4, matching local ix-builder behavior and OpenAPI `protocol` + `poolAddress` documentation.

## Actual

Vybe API v4 appears to only forward or honor the full pin when **all three** fields are present. Likely causes:

1. `programAddress` is not in the public OpenAPI schema and may be dropped by the v4 proxy unless paired with `protocol`.
2. `protocol` + `poolAddress` alone may not be mapped through to ix-builder pinned path on the gateway.

## Impact

- Route via Trades and any client sending only `poolAddress` + `programAddress` (from trade rows) gets wrong routes on Vybe API.
- Manual pool + protocol UI pins fail unless `programAddress` is also sent.

## Workaround (swap-api demo)

Clients should **always send all three** when pinning a pool on Vybe router:

```json
{
  "router": "vybe",
  "poolAddress": "6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp",
  "programAddress": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "protocol": "METEORADLMM"
}
```

`solana-swap-api` now auto-fills the missing field(s) from the program ↔ protocol map in `src/api/pinned-swap-params.ts`.

## Suggested fix (Vybe API team)

1. Document `programAddress` on `POST /v4/trading/swap`.
2. Forward `programAddress` and `protocol` to ix-builder for all pin combinations.
3. Add integration tests mirroring the three scenarios above.

## References

- ix-builder PR: `DATA-2515-pinned-swap-protocol` (Bitbucket `ix-builder-api-main-nodejs`)
- Local verification: ix-builder `/swap` — all 3 scenarios OK (2026-06-12)
- Production verification: Vybe API — only all-three OK (2026-06-12)
