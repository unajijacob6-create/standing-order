import { useEffect, useState } from "react";
import type { Destination } from "../near";
import { getDestination } from "../near";
import { DESTINATIONS, destinationLabel } from "../config";
import { validateDestination } from "../address";
import { isCancellation } from "../wallet";

export function DestinationPanel({ accountId, connected, onSignIn, onSignOut, call }: { accountId: string; connected: boolean; onSignIn: () => Promise<void>; onSignOut: () => Promise<void>; call: (m: string, a: Record<string, unknown>, deposit?: string, gas?: string) => Promise<any> }) {
  const [dest, setDest] = useState<Destination | null>(null);
  const [asset, setAsset] = useState(DESTINATIONS[0].id);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean | null; text: string } | null>(null); // ok null = neutral (cancelled)
  const chain = DESTINATIONS.find((d) => d.id === asset)?.chain ?? "";
  const addrError = address.trim() ? validateDestination(chain, address) : null;
  const canSave = !busy && address.trim() !== "" && addrError === null;
  const fail = (e: unknown) =>
    setMsg(isCancellation(e) ? { ok: null, text: "Cancelled in your wallet. Nothing was sent." } : { ok: false, text: String((e as any)?.message ?? e).slice(0, 200) });

  const refresh = async () => {
    if (!accountId) return setDest(null);
    setDest(await getDestination(accountId).catch(() => null));
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const save = async () => {
    const err = validateDestination(chain, address);
    if (err) return setMsg({ ok: false, text: err });
    setBusy(true);
    setMsg(null);
    try {
      await call("register_destination", { asset_id: asset, address: address.trim() }, "10000000000000000000000"); // 0.01 NEAR for storage, excess refunded
      setMsg({ ok: true, text: "Saved. Your next payout will be routed through NEAR Intents." });
      setAddress("");
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await call("clear_destination", {});
      setMsg({ ok: true, text: "Cleared. You will be paid on NEAR again." });
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card pad">
      <div className="section-head">
        <h2>Get paid on another chain</h2>
        {connected ? <button className="btn ghost sm" onClick={onSignOut}>{accountId.length > 20 ? accountId.slice(0, 18) + "…" : accountId} · sign out</button> : <button className="btn sm" onClick={onSignIn}>Connect wallet</button>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Recipients choose. Register a destination and each payout is swapped and delivered through NEAR Intents; the contract only pays a deposit
        address that 1Click has signed for <em>your</em> registered address, and refunds come back to your NEAR account.
      </p>
      <p className="muted tiny" style={{ marginTop: 0 }}>
        <b>Fiat / off-ramp.</b> Fiat is out of scope: register the USDC deposit address of your exchange or off-ramp on a supported chain. 1Click
        fee is 0.25% without a partner token, 1 bp on stablecoin routes with one.
      </p>
      {!connected ? (
        <div className="note">Connect the wallet of a recipient account to set or change its destination.</div>
      ) : (
        <div className="form">
          {dest ? (
            <div className="note">
              Current: <b>{destinationLabel(dest.asset_id)}</b> → <code>{dest.address}</code>
              <div style={{ marginTop: 8 }}><button className="btn ghost sm" onClick={clear} disabled={busy}>Pay me on NEAR instead</button></div>
            </div>
          ) : (
            <div className="note">No destination registered: payouts arrive in your NEAR account.</div>
          )}
          <label>
            Destination asset
            <select value={asset} onChange={(e) => setAsset(e.target.value)}>
              {DESTINATIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </label>
          <label>
            Your address on that chain
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={chain === "Solana" ? "Solana address (base58)" : "0x… (40 hex characters)"} spellCheck={false} autoComplete="off" aria-invalid={addrError !== null} aria-describedby="dest-addr-err" />
          </label>
          {addrError && <div id="dest-addr-err" className="tiny err-text" role="alert">{addrError}</div>}
          <div className="row">
            <button className="btn accent" onClick={save} disabled={!canSave}>{busy ? "Signing…" : dest ? "Update destination" : "Register destination"}</button>
            <span className="tiny">Costs ≈0.01 NEAR of storage, refunded if less is used.</span>
          </div>
          {msg && <div className={msg.ok === null ? "muted" : msg.ok ? "ok-text" : "err-text"}>{msg.text}</div>}
        </div>
      )}
    </div>
  );
}
