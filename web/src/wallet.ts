import { useCallback, useEffect, useMemo, useState } from "react";
import { NearConnector } from "@hot-labs/near-connect";
import { CONTRACT, NETWORK } from "./config";

/** Did the user dismiss the wallet picker or reject the request in their wallet (as opposed to a real failure)? */
export function isCancellation(e: unknown): boolean {
  const m = String((e as any)?.message ?? e ?? "");
  return /reject|cancel|closed/i.test(m);
}

export function useWallet() {
  const connector = useMemo(() => new NearConnector({ network: NETWORK }), []);
  const [accountId, setAccountId] = useState<string>("");
  const [wallet, setWallet] = useState<any>(undefined);

  useEffect(() => {
    let cancelled = false;
    const onIn = (payload: any) => {
      if (cancelled) return;
      setWallet(payload.wallet);
      setAccountId(payload.accounts?.[0]?.accountId ?? "");
    };
    const onOut = () => {
      if (cancelled) return;
      setWallet(undefined);
      setAccountId("");
    };
    connector.on("wallet:signIn", onIn);
    connector.on("wallet:signOut", onOut);
    connector
      .wallet()
      .then(async (w: any) => {
        if (cancelled || !w) return;
        const accounts = await w.getAccounts();
        setWallet(w);
        setAccountId(accounts?.[0]?.accountId ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      connector.off?.("wallet:signIn", onIn);
      connector.off?.("wallet:signOut", onOut);
    };
  }, [connector]);

  /** Opens the wallet picker. Resolves true once connected, false if the user dismissed it; real errors still throw. */
  const signIn = useCallback(async (): Promise<boolean> => {
    let w: any;
    try {
      w = await connector.connect();
    } catch (e) {
      if (isCancellation(e)) return false;
      throw e;
    }
    if (!w) return false;
    setWallet(w);
    const accounts = await w.getAccounts();
    setAccountId(accounts?.[0]?.accountId ?? "");
    return Boolean(accounts?.[0]?.accountId);
  }, [connector]);

  const signOut = useCallback(async () => {
    if (wallet) await connector.disconnect(wallet);
    setWallet(undefined);
    setAccountId("");
  }, [connector, wallet]);

  const call = useCallback(
    async (methodName: string, args: Record<string, unknown>, deposit = "0", gas = "30000000000000") => {
      const w: any = wallet ?? (await connector.wallet());
      return w.signAndSendTransaction({
        receiverId: CONTRACT,
        actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }],
      });
    },
    [connector, wallet],
  );

  return { accountId, signIn, signOut, call, connected: Boolean(accountId) };
}
