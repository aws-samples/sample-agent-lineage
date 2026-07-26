import { useEffect, useState } from "react";
import { fetchAccessRequests, submitAccessRequest } from "../api";
import type { AccessRequest } from "../types";

/** Shown to viewers (in place of the graph) when they have no account access
 *  yet, or via "Request access" to ask for another account. Admins are
 *  notified by email and approve in-app. Rejected requests are final -- file
 *  a new one (keeps a clean history). */
export function AccessRequestForm() {
  const [accountName, setAccountName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [history, setHistory] = useState<AccessRequest[]>([]);

  const loadHistory = () =>
    fetchAccessRequests().then(setHistory).catch(() => setHistory([]));

  useEffect(() => {
    loadHistory();
  }, []);

  const submit = async () => {
    setError(null);
    if (!/^\d{12}$/.test(accountId)) {
      setError("Account ID must be exactly 12 digits.");
      return;
    }
    if (!accountName.trim() || !reason.trim()) {
      setError("All fields are required.");
      return;
    }
    setBusy(true);
    try {
      await submitAccessRequest({
        account_name: accountName.trim(),
        account_id: accountId,
        reason: reason.trim(),
      });
      setSubmitted(true);
      setAccountName("");
      setAccountId("");
      setReason("");
      loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusChip = (s: AccessRequest["status"]) =>
    s === "approved" ? "allow-chip" : s === "rejected" ? "deny-chip" : "pending-chip";

  return (
    <div className="access-request">
      <div className="empty-icon">🔐</div>
      <h2>Request account access</h2>
      <p className="hint">
        You don't have access to any AWS account lineage yet — or need another
        one. Submit a request and an admin will review it.
      </p>

      {submitted && (
        <div className="access-ok" role="status">
          ✓ Request submitted. Admins have been notified — you'll get access
          once it's approved.
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <div className="aws-form access-form">
        <label>
          Account name
          <input
            value={accountName}
            placeholder="e.g. platform-prod"
            maxLength={200}
            onChange={(e) => setAccountName(e.target.value)}
          />
        </label>
        <label>
          Account ID <small>(12 digits)</small>
          <input
            value={accountId}
            placeholder="123456789012"
            inputMode="numeric"
            maxLength={12}
            onChange={(e) => setAccountId(e.target.value.replace(/\D/g, ""))}
          />
        </label>
        <label>
          Reason
          <textarea
            value={reason}
            placeholder="Why do you need lineage visibility into this account?"
            rows={3}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button className="focus-btn aws-sync-btn" disabled={busy} onClick={submit}>
          {busy ? "Submitting…" : "Submit request"}
        </button>
      </div>

      {history.length > 0 && (
        <div className="access-history">
          <h3>Your requests</h3>
          <table className="cost-table">
            <thead>
              <tr><th>Account</th><th>ID</th><th>Status</th><th>Requested</th></tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td>{r.account_name}</td>
                  <td><code>{r.account_id}</code></td>
                  <td><span className={statusChip(r.status)}>{r.status}</span></td>
                  <td>{r.created_at ? new Date(r.created_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
