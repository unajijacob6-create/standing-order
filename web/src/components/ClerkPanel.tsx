import { useEffect, useState } from "react";

export interface ReviewIndexItem {
  file: string;
  proposal_id: number;
  type: "review" | "draft";
  verdict: "ok" | "warn" | "block";
  recommend?: string;
  headline?: string;
  verified?: boolean;
  model?: string;
  at: string;
}

const BASE = import.meta.env.BASE_URL ?? "/";

export function useClerkReviews(): ReviewIndexItem[] {
  const [items, setItems] = useState<ReviewIndexItem[]>([]);
  useEffect(() => {
    fetch(`${BASE}reviews/index.json`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((j) => setItems(Array.isArray(j) ? j.slice().sort((a, b) => b.proposal_id - a.proposal_id) : []))
      .catch(() => setItems([]));
  }, []);
  return items;
}

export function ClerkBadge({ review }: { review?: ReviewIndexItem }) {
  if (!review) return null;
  const tone = review.verdict === "block" ? "failed" : review.verdict === "warn" ? "blue" : "active";
  return (
    <a className={`chip ${tone}`} href={`${BASE}reviews/${review.file}`} target="_blank" rel="noreferrer" title={review.headline}>
      Clerk · {review.recommend ?? review.verdict}{review.verified ? " · TEE-verified" : ""}
    </a>
  );
}

interface CheckRow {
  ok: boolean | null;
  label: string;
  value?: string;
  full?: string;
  copy?: string;
  note?: string;
}

const short = (s: unknown, head = 10, tail = 6) => {
  const str = s === null || s === undefined ? "" : String(s);
  return str.length <= head + tail + 1 ? str : `${str.slice(0, head)}…${str.slice(-tail)}`;
};

/** The receipt's `checks` are the verifier's own words (strings), or objects {name|check, ok|passed, detail} in newer receipts. */
function normaliseChecks(receipt: any): CheckRow[] {
  const verified = receipt?.verified === true;
  const list: any[] = Array.isArray(receipt?.checks) ? receipt.checks : [];
  return list.map((c) => {
    if (typeof c === "string") return { ok: verified, label: c };
    const label = String(c.name ?? c.check ?? c.label ?? c.id ?? "check");
    const ok = typeof c.ok === "boolean" ? c.ok : typeof c.passed === "boolean" ? c.passed : typeof c.pass === "boolean" ? c.pass : verified;
    return { ok, label, note: c.detail ?? c.message ?? undefined };
  });
}

function receiptRows(open: any): CheckRow[] {
  const r = open?.receipt ?? {};
  const att = r.attestation ?? {};
  const signers: string[] = att.model_signing_addresses ?? [];
  const signerOk = r.recovered_signer ? signers.map((s) => s.toLowerCase()).includes(String(r.recovered_signer).toLowerCase()) : null;
  const rows: CheckRow[] = [
    ...normaliseChecks(r),
    { ok: null, label: "model", value: r.model ?? open?.model, full: r.model ?? open?.model },
    {
      ok: att.nonce_echoed === true ? true : att.nonce_echoed === false ? false : null,
      label: "attestation nonce",
      value: short(r.nonce, 12, 6),
      full: r.nonce,
      copy: r.nonce,
      note: att.nonce_echoed === true ? "echoed · fresh report" : att.nonce_echoed === false ? "not echoed" : undefined,
    },
    { ok: signerOk, label: "signer", value: short(r.recovered_signer ?? r.signature?.signing_address, 8, 6), full: r.recovered_signer, copy: r.recovered_signer, note: r.signed_by ? `${r.signed_by}${signerOk ? " · attested" : ""}` : undefined },
    { ok: null, label: "request sha256", value: short(r.request_hash, 10, 6), full: r.request_hash, copy: r.request_hash },
    { ok: null, label: "response sha256", value: short(r.response_hash, 10, 6), full: r.response_hash, copy: r.response_hash },
    { ok: null, label: "chat id", value: short(r.chat_id, 10, 6), full: r.chat_id, copy: r.chat_id },
  ];
  if (att.has_intel_quote !== undefined || att.has_nvidia_payload !== undefined) {
    rows.splice(normaliseChecks(r).length, 0, {
      ok: Boolean(att.has_intel_quote) && Boolean(att.has_nvidia_payload),
      label: "attestation report",
      note: [att.has_intel_quote ? "Intel TDX quote" : "no Intel quote", att.has_nvidia_payload ? "NVIDIA GPU payload" : "no NVIDIA payload"].join(" · "),
    });
  }
  return rows.filter((row) => row.value !== "" || row.ok !== null || row.note);
}

function Glyph({ ok }: { ok: boolean | null }) {
  if (ok === true)
    return (
      <span className="vglyph ok" aria-label="passed">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6.5 5 9l4.5-6" /></svg>
      </span>
    );
  if (ok === false)
    return (
      <span className="vglyph bad" aria-label="failed">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg>
      </span>
    );
  return <span className="vglyph info" aria-hidden />;
}

function Copyable({ text, label, full }: { text: string; label?: string; full?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked: the title still shows the full value */
    }
  };
  return (
    <button type="button" className="vcopy mono" onClick={onClick} title={copied ? "copied" : `${full ?? text} · click to copy`}>
      {label ?? text}
      <span className="vcopy-hint">{copied ? "copied" : "copy"}</span>
    </button>
  );
}

export function ClerkPanel({ reviews }: { reviews: ReviewIndexItem[] }) {
  const [open, setOpen] = useState<any | null>(null);
  const latest = reviews[0];
  useEffect(() => {
    if (!latest) return;
    fetch(`${BASE}reviews/${latest.file}`).then((r) => r.json()).then(setOpen).catch(() => setOpen(null));
  }, [latest?.file]);
  const rows = open ? receiptRows(open) : [];
  const verified = open?.receipt?.verified === true;
  // Collapsed to one summary line by default; opens by itself if anything failed.
  const [verifyOpen, setVerifyOpen] = useState(false);
  useEffect(() => { if (open && (!verified || rows.some((r) => r.ok === false))) setVerifyOpen(true); }, [open?.receipt?.chat_id]);
  return (
    <div className="card pad" id="clerk">
      <div className="section-head">
        <h2>Private payroll clerk</h2>
        <span className="pill"><span className="dot" style={{ background: "var(--green)" }} />NEAR AI Cloud · TEE</span>
      </div>
      <p className="muted">
        Before a payroll proposal goes to a vote, the clerk checks it: amounts in the wrong units, duplicates, unknown or non-existent
        accounts, raises, runway. It can also draft the proposal from contributor invoices. Salary data goes only to a NEAR-operated model
        inside a hardware enclave, and every run returns a signed receipt anyone can re-verify.
      </p>
      {!open ? (
        <div className="empty">No clerk reviews published yet.</div>
      ) : (
        <div className="form">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>{open.type === "draft" ? `Draft → proposal #${open.proposal_id}` : `Review of proposal #${open.proposal_id}`}</b>
            <span className={`chip ${open.verdict === "block" ? "failed" : open.verdict === "warn" ? "blue" : "active"}`}>{open.brief?.recommend ?? open.verdict}</span>
          </div>
          {open.brief?.headline && <div>{open.brief.headline}</div>}
          {open.summary && <div className="muted">{open.summary}</div>}
          {(open.findings ?? []).length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {open.findings.map((f: any, i: number) => (
                <li key={i} className={f.level === "block" ? "err-text" : f.level === "warn" ? "" : "muted"} style={{ fontSize: 13.5 }}>{f.message}</li>
              ))}
            </ul>
          )}
          {(open.brief?.risks ?? []).filter((r: string) => r.includes("(model)")).map((r: string, i: number) => (
            <div key={i} className="tiny">model note: {r.replace("(model)", "").trim()}</div>
          ))}

          <div className="verify" aria-label="What was verified">
            <button type="button" className="verify-head verify-toggle" aria-expanded={verifyOpen} onClick={() => setVerifyOpen(!verifyOpen)}>
              <h3>What was verified</h3>
              <span className="tiny muted">{rows.filter((r) => r.ok === true).length} checks passed</span>
              <span className="spacer" />
              <span className={`chip ${verified ? "active" : "failed"}`}>{verified ? "signature verified" : "unverified"}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden className={verifyOpen ? "flip" : ""}><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {verifyOpen && (<>
            <ul className="verify-list">
              {rows.map((row, i) => (
                <li key={i} className="verify-row">
                  <Glyph ok={row.ok} />
                  <span className="vlabel">{row.label}</span>
                  <span className="vval">
                    {row.value && (row.copy ? <Copyable text={row.copy} label={row.value} full={row.full} /> : <span className="mono" title={row.full}>{row.value}</span>)}
                    {row.note && <span className="vnote">{row.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <div className="verify-foot mono">
              Re-verify offline: <code>npm run judge</code>
              <span className="vnote">recovers the signer from the stored hashes and checks it against today's attestation report</span>
            </div>
            </>)}
          </div>

          <div className="row">
            <a className="btn ghost sm" href={`${BASE}reviews/${latest!.file}`} target="_blank" rel="noreferrer" title="The clerk's raw receipt file (JSON): model, nonce, hashes, signature, attestation summary">See the signed receipt ↗</a>
            {reviews.length > 1 && <span className="tiny">{reviews.length} reviews published</span>}
          </div>
        </div>
      )}
    </div>
  );
}
