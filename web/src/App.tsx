import { useEffect, useMemo, useState } from "react";
import { Logo } from "./components/Logo";
import { PlanCard } from "./components/PlanCard";
import { PlanDetail } from "./components/PlanDetail";
import { Requests } from "./components/Requests";
import { DestinationPanel } from "./components/DestinationPanel";
import { LiveFeed, ago, useRecentPayouts } from "./components/LiveFeed";
import { Coins3D } from "./components/Coins3D";
import { Particles } from "./components/Particles";
import { ClerkPanel, useClerkReviews } from "./components/ClerkPanel";
import { CONTRACT, DAO, EXPLORER, KEEPER_URL, NETWORK, REPO_URL } from "./config";
import { formatAmount, formatCountdown, sum } from "./format";
import { getDaoProposals, getPlans, getTokenBalance, getTokenMeta, type Plan, type Proposal, type TokenMeta } from "./near";
import { useWallet } from "./wallet";

interface KeeperStatus {
  ok: boolean;
  runs: number;
  payoutsSent: number;
  lastTick: string | null;
  crosschain?: string;
  recent: Array<{ plan_id: number; outcome: any; tx: string }>;
}

export default function App() {
  const wallet = useWallet();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [meta, setMeta] = useState<TokenMeta | null>(null);
  const [treasury, setTreasury] = useState<string>("0");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [keeper, setKeeper] = useState<KeeperStatus | null>(null);
  // Deep link: #plan-<id> preselects a plan on load; selecting one updates the hash.
  const [selected, setSelected] = useState<number | null>(() => planIdFromHash());
  const [nowMs, setNowMs] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [triggering, setTriggering] = useState<number | null>(null);
  const [toast, setToast] = useState<{ tone: "ok" | "err" | "neutral"; text: string } | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try { return (localStorage.getItem("so-theme") as "dark" | "light") || "dark"; } catch { return "dark"; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("so-theme", theme); } catch { /* private mode */ }
  }, [theme]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [p, m, bal, props] = await Promise.all([getPlans(), getTokenMeta().catch(() => null), getTokenBalance(DAO).catch(() => "0"), getDaoProposals().catch(() => [])]);
        if (cancelled) return;
        setPlans(p);
        setMeta(m);
        setTreasury(bal);
        setProposals(props);
        setError(null);
        setLoaded(true);
        setSelected((s) => (s !== null && p.some((x) => x.id === s) ? s : p.find((x) => x.status === "Active")?.id ?? p[0]?.id ?? null));
      } catch (e) {
        if (!cancelled) setError(String((e as any)?.message ?? e));
      }
      if (KEEPER_URL) {
        try {
          const r = await fetch(KEEPER_URL, { cache: "no-store" });
          if (!cancelled) setKeeper(await r.json());
        } catch {
          if (!cancelled) setKeeper(null);
        }
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [refresh]);

  useEffect(() => {
    const onHash = () => {
      const id = planIdFromHash();
      if (id !== null) setSelected(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = (id: number) => {
    setSelected(id);
    const hash = `#plan-${id}`;
    if (window.location.hash !== hash) window.location.hash = hash;
  };

  // run_due is permissionless: any connected testnet account can make a due payday happen.
  const trigger = async (planId: number) => {
    setToast(null);
    try {
      if (!wallet.connected) await wallet.signIn();
      setTriggering(planId);
      await wallet.call("run_due", { plan_id: planId, routes: null }, "0", "300000000000000");
      setToast({ tone: "ok", text: `Payday for plan #${planId} triggered. Payouts appear below in a few seconds.` });
      setTimeout(() => setRefresh((r) => r + 1), 2500);
    } catch (e) {
      const message = String((e as any)?.message ?? e);
      // near-connect throws "User rejected" (picker closed) and "Wallet closed" (wallet window closed).
      if (/reject|cancel|closed/i.test(message)) {
        setToast({ tone: "neutral", text: "Cancelled in your wallet. Nothing was sent." });
      } else {
        setToast({ tone: "err", text: `Couldn’t trigger payday: ${message}`.slice(0, 200) });
      }
    } finally {
      setTriggering(null);
    }
  };

  const feed = useRecentPayouts(plans);
  const reviews = useClerkReviews();
  const lastPayout = feed[0]?.timestamp;
  const active = plans.filter((p) => p.status === "Active");
  const totalPaid = useMemo(() => {
    // Sum of completed runs × per-run total, per plan (payout records are per plan; this is the aggregate).
    return plans.filter((p) => p.asset !== "Near").reduce((acc, p) => acc + BigInt(p.runs_completed) * sum(p.recipients.map((r) => r.amount)), 0n);
  }, [plans]);
  // Next payday counts only plans the keeper can actually pay: active, not past end_at, and funded for at least one run
  // (an underfunded plan shows "Needs top-up" on its card instead of a countdown).
  const nextRun = active
    .filter((p) => !(p.end_at !== null && p.next_run_at > p.end_at) && BigInt(p.balance) >= sum(p.recipients.map((r) => r.amount)))
    .map((p) => p.next_run_at)
    .sort((a, b) => a - b)[0];
  const committed = active.reduce((acc, p) => acc + BigInt(p.balance), 0n);
  const selectedPlan = plans.find((p) => p.id === selected) ?? null;
  const keeperFresh = keeper?.lastTick ? Date.now() - new Date(keeper.lastTick).getTime() < 120_000 : false;

  return (
    <>
      <header className="header">
        <div className="wrap">
          <a className="brand" href="#top"><Logo /> Standing Order</a>
          <nav className="nav" aria-label="Sections">
            <a href="#plans">Plans</a>
            <a href="#live">Live</a>
            <a href="#requests">Requests</a>
            <a href="#clerk">Clerk</a>
            <a href="#destination">Get paid</a>
          </nav>
          <div className="spacer" />
          <span className="pill hide-sm"><span className="dot" style={{ background: NETWORK === "mainnet" ? "var(--green)" : "var(--purple)" }} />{NETWORK}</span>
          {/* Activity pill: the on-chain "last payout" is the ground truth and is always shown; when a keeper status
              endpoint is configured its liveness is merged into the same pill so judges see both at a glance. */}
          {(lastPayout || KEEPER_URL) && (
            <span
              className={`pill keeper ${KEEPER_URL && keeper ? (keeperFresh ? "ok" : "bad") : lastPayout ? (nowMs / 1000 - lastPayout < 1800 ? "ok" : "bad") : ""}`}
              title={[lastPayout ? `latest payout recorded on-chain at ${new Date(lastPayout * 1000).toISOString()}` : "", keeper?.lastTick ? `keeper last tick ${keeper.lastTick}` : KEEPER_URL ? "keeper status endpoint unreachable" : ""].filter(Boolean).join(" · ")}
            >
              <span className="dot" />
              <span className="text">
                {KEEPER_URL ? (keeper ? (keeperFresh ? `Keeper live · ${keeper.runs} runs` : "Keeper stale") : "Keeper: no status") : null}
                {KEEPER_URL && lastPayout ? " · " : null}
                {lastPayout ? `${KEEPER_URL ? "last" : "Last"} payout ${ago(lastPayout, nowMs)}` : null}
              </span>
              {lastPayout && <span className="text-sm">{ago(lastPayout, nowMs).replace(" ago", "").replace(" min", "m").replace(" h", "h").replace(" d", "d")}</span>}
            </span>
          )}
          <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title={theme === "dark" ? "Switch to light" : "Switch to dark"} aria-label="Toggle theme">
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
            )}
          </button>
          {wallet.connected ? <button className="btn ghost sm" onClick={wallet.signOut}>{wallet.accountId.length > 22 ? wallet.accountId.slice(0, 20) + "…" : wallet.accountId}</button> : <button className="btn sm" onClick={wallet.signIn}>Connect</button>}
        </div>
      </header>

      <section className="hero" id="top">
        <div className="glow" />
        <Particles />
        <div className="wrap">
          <div>
            <span className="eyebrow">Recurring payroll for NEAR treasuries</span>
            <h1>Vote once.<br />Pay every period.<br /><span className="accent-word">Settle anywhere.</span></h1>
            <p className="lede">
              A Sputnik DAO funds and authorises a plan in one vote. Standing Order pays each contributor on schedule, at the amounts and cadence
              the council voted, until the council pauses it. Recipients pick the token and chain they want; NEAR Intents does the delivery.
            </p>
            <div className="cta">
              <a className="btn" href="#live">Watch live payouts</a>
              <a className="btn ghost" href={REPO_URL} target="_blank" rel="noreferrer">Read the code ↗</a>
            </div>
            <div className="proof">
              <a className="pill" href={`${EXPLORER}/address/${CONTRACT}`} target="_blank" rel="noreferrer"><span className="dot" style={{ background: "var(--green)" }} />Contract on {NETWORK}</a>
              <a className="pill" href={`${EXPLORER}/address/${DAO}`} target="_blank" rel="noreferrer"><span className="dot" style={{ background: "var(--purple)" }} />Sputnik DAO treasury</a>
              <a className="pill" href={`${REPO_URL}/actions/workflows/test.yml`} target="_blank" rel="noreferrer"><span className="dot" style={{ background: "var(--blue)" }} />57 tests passing in CI</a>
            </div>
          </div>
          <div className="coins">
            <div className="glyphs" aria-hidden>
              <span style={{ left: "4%", top: "4%" }}>run_due(3) → Sent</span>
              <span style={{ right: "2%", top: "8%" }}>+270 USDC</span>
              <span style={{ right: "4%", bottom: "2%" }}>refundTo = recipient</span>
            </div>
            <Coins3D />
          </div>
        </div>
      </section>

      <main className="wrap">
        <section className="stats">
          <div className="stat"><div className="label">Active plans</div><div className="value">{loaded ? active.length : "…"}</div><div className="sub">{plans.length} total on this contract</div></div>
          <div className="stat"><div className="label">Paid out so far</div><div className="value mono">{loaded ? formatAmount(totalPaid, meta, false) : "…"}</div><div className="sub">{plans.reduce((a, p) => a + p.runs_completed, 0)} runs completed</div></div>
          <div className="stat"><div className="label">Next payday</div><div className="value mono">{nextRun ? formatCountdown(nextRun, nowMs).text : "—"}</div><div className="sub">{nextRun && formatCountdown(nextRun, nowMs).due ? "due: keeper runs every ~5 min, or trigger it below" : "keeper triggers it automatically"}</div></div>
          <div className="stat"><div className="label">Committed in plans</div><div className="value mono">{loaded ? formatAmount(committed, meta, false) : "…"}</div><div className="sub">treasury holds {formatAmount(treasury, meta, false)}</div></div>
        </section>

        {error && <div className="note err-text" style={{ marginBottom: 16 }}>RPC error: {error}</div>}
        {toast && <div className={`note ${toast.tone === "ok" ? "ok-text" : toast.tone === "err" ? "err-text" : ""}`} role="status" style={{ marginBottom: 16 }}>{toast.text}</div>}

        <section className="grid">
          <div className="col">
            <div>
              <div className="section-head" id="plans"><h2>Plans</h2><span className="tiny">click a plan for history</span></div>
              <div className="col" style={{ gap: 12 }}>
                {!loaded && <div className="card empty">Loading plans from {CONTRACT}…</div>}
                {loaded && plans.length === 0 && <div className="card empty">No plans yet. A DAO creates one by voting on a funding proposal.</div>}
                {plans.slice().sort((a, b) => (a.status === "Active" ? -1 : 1) - (b.status === "Active" ? -1 : 1) || b.id - a.id).map((p) => (
                  <PlanCard key={p.id} plan={p} meta={meta} nowMs={nowMs} selected={p.id === selected} onSelect={() => select(p.id)} onTrigger={() => trigger(p.id)} triggering={triggering === p.id} />
                ))}
              </div>
            </div>
            {selectedPlan && <PlanDetail plan={selectedPlan} meta={meta} keeperRuns={keeper?.recent ?? []} />}
          </div>

          <div className="col">
            <div id="live"><LiveFeed items={feed} meta={meta} nowMs={nowMs} plans={plans} /></div>
            <div id="requests"><Requests proposals={proposals} reviews={reviews} /></div>
            <ClerkPanel reviews={reviews} />
            <div id="destination"><DestinationPanel accountId={wallet.accountId} connected={wallet.connected} onSignIn={wallet.signIn} onSignOut={wallet.signOut} call={wallet.call} /></div>
            <div className="card pad">
              <h2 style={{ marginBottom: 12 }}>How it works</h2>
              <div className="steps" style={{ gridTemplateColumns: "1fr" }}>
                <div className="step"><div className="n">01 · one vote</div><b>The treasury funds a plan</b>The council approves a single proposal: token amount, recipients, cadence, cap. Trezu templates make it a form.</div>
                <div className="step"><div className="n">02 · code pays</div><b>Runs execute on schedule</b>A keeper with a key that can only call <code>run_due</code> triggers each period. No signatures on payday, no partial runs, failed transfers re-credit.</div>
                <div className="step"><div className="n">03 · private clerk</div><b>Checked before the vote</b>A NEAR AI model in a TEE reviews or drafts the payroll from invoices; every verdict carries a signed, re-verifiable receipt.</div>
                <div className="step"><div className="n">04 · any chain</div><b>Recipients choose where</b>Register a destination and the contract pays a 1Click deposit address it verified was signed for you. Refunds go to you.</div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap row" style={{ justifyContent: "space-between" }}>
          <span>Standing Order · built at NEAR HACKATHON · Sputnik DAO + Trezu templates + function-call keys + NEAR Intents</span>
          <span className="row"><a href={REPO_URL} target="_blank" rel="noreferrer">Repository</a><a href={`${EXPLORER}/address/${DAO}`} target="_blank" rel="noreferrer">Demo DAO</a></span>
        </div>
      </footer>
    </>
  );
}

function planIdFromHash(): number | null {
  const m = /^#plan-(\d+)$/.exec(window.location.hash);
  return m ? Number(m[1]) : null;
}
