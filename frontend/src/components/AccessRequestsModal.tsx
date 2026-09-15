import { useEffect, useState } from "react";
import { decideAccessRequest, fetchAccessRequests } from "../api";
import type { AccessRequest } from "../types";

interface Props {
  onClose: () => void;
}

/** Admin-only: review pending access requests. Approving writes the account
 *  grant to the requester's Cognito custom:allowed_namespaces attribute. */
export function AccessRequestsModal({ onClose }: Props) {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetchAccessRequests().then(setRequests).catch((e: Error) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const decide = async (id: number, action: "approve" | "reject") => {
    setBusyId(id);
    setError(null);
    try {
      await decideAccessRequest(id, action);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal aws-modal"
        role="dialog"
        aria-label="Access requests"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2>Access requests</h2>
            <p className="hint">
              Approving grants the requester read access to every synced region
              of that account. Rejected requests are final — the viewer files a
              new one if needed.
            </p>
          </div>
          <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
        {error && <div className="error aws-result">{error}</div>}

        <h3>Pending ({pending.length})</h3>
        {pending.length === 0 && <p className="hint">Nothing waiting on you.</p>}
        {pending.map((r) => (
          <div key={r.id} className="aws-result access-pending">
            <div className="aws-result-head">
              <b>{r.requester_email || "unknown user"}</b> requests{" "}
              <b>{r.account_name}</b> (<code>{r.account_id}</code>)
              <span className="access-date">
                {r.created_at ? new Date(r.created_at).toLocaleString() : ""}
              </span>
            </div>
            <p className="access-reason">“{r.reason}”</p>
            <div className="access-actions">
              <button
                className="focus-btn approve-btn"
                disabled={busyId === r.id}
                onClick={() => decide(r.id, "approve")}
              >
                {busyId === r.id ? "…" : "✓ Approve"}
              </button>
              <button
                className="focus-btn reject-btn"
                disabled={busyId === r.id}
                onClick={() => decide(r.id, "reject")}
              >
                ✗ Reject
              </button>
            </div>
          </div>
        ))}

        {decided.length > 0 && (
          <>
            <h3>History</h3>
            <table className="cost-table">
              <thead>
                <tr>
                  <th>Requester</th><th>Account</th><th>Status</th>
                  <th>Decided by</th><th>When</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((r) => (
                  <tr key={r.id}>
                    <td>{r.requester_email}</td>
                    <td>{r.account_name} <code>{r.account_id}</code></td>
                    <td>
                      <span className={r.status === "approved" ? "allow-chip" : "deny-chip"}>
                        {r.status}
                      </span>
                    </td>
                    <td>{r.decided_by || "—"}</td>
                    <td>{r.decided_at ? new Date(r.decided_at).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        </div>
      </div>
    </div>
  );
}
