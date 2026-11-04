import { setting } from "../env.js";
import { amount } from "../format.js";
import { fetchJson } from "../http.js";
import { NotConfiguredError, type CheckConfig, type Probe } from "../types.js";

/**
 * Balance of an EVM address over JSON-RPC. Native coin by default (gas for the Termix hot wallets:
 * accept / deliver / claim each cost one transaction), or an ERC-20 when `token` is set.
 */
export async function evmBalance(cfg: CheckConfig): Promise<Probe> {
  const rpc = setting(cfg, "rpcUrl", true) ?? "https://bsc-dataseed.bnbchain.org";
  const address = setting(cfg, "address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new NotConfiguredError(`地址格式不对: ${address}`);
  const symbol = setting(cfg, "symbol", true) ?? "BNB";
  const decimals = Number(setting(cfg, "decimals", true) ?? 18);
  const token = setting(cfg, "token", true);

  const raw = token
    ? await rpcCall(rpc, "eth_call", [{ to: token, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"])
    : await rpcCall(rpc, "eth_getBalance", [address, "latest"]);
  const value = toUnits(BigInt(raw), decimals);
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const notes = [short];

  if (!token) {
    // Rough "how many more transactions" so a low balance means something at a glance.
    const gasPerTx = Number(cfg.gasPerTx ?? 200_000);
    try {
      const gasPrice = BigInt(await rpcCall(rpc, "eth_gasPrice", []));
      const perTx = toUnits(gasPrice * BigInt(gasPerTx), 18);
      if (perTx > 0) notes.push(`约够 ${Math.floor(value / perTx).toLocaleString("en-US")} 笔交易`);
    } catch {
      // The estimate is optional.
    }
  }
  return { metric: { value, unit: symbol }, note: notes.join("，") };
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<string> {
  const res = await fetchJson(url, { body: { jsonrpc: "2.0", id: 1, method, params } });
  if (res?.error) throw new Error(`RPC ${method}: ${res.error.message ?? JSON.stringify(res.error)}`);
  if (typeof res?.result !== "string") throw new Error(`RPC ${method}: 没有 result`);
  return res.result === "0x" ? "0x0" : res.result;
}

function toUnits(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(raw / scale) + Number(raw % scale) / Number(scale);
}
