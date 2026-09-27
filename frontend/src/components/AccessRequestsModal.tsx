import { useEffect, useState } from "react";
import { decideAccessRequest, fetchAccessRequests } from "../api";
import type { AccessRequest } from "../types";
import { Icon } from "./Icon";
import { ModalFrame } from "./Motion";

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
  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

  return (
    <ModalFrame className="modal requests-modal" label="Access requests" onClose={onClose}>
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

      <div className="modal-body requests-body">
        {error && <div className="error requests-error">{error}</div>}

        <section className="requests-section">
          <h3 className="requests-title">
            Pending
            <span className={`requests-count${pending.length ? " requests-count-live" : ""}`}>
              {pending.length}
            </span>
          </h3>
          {pending.length === 0 ? (
            <p className="requests-empty">Nothing waiting on you.</p>
          ) : (
            <ul className="requests-list">
              {pending.map((r) => (
                <li key={r.id} className="request-card">
                  <div className="request-main">
                    <div className="request-who">
                      <span className="request-email">{r.requester_email || "unknown user"}</span>
                      <span className="request-when">{when(r.created_at)}</span>
                    </div>
                    <div className="request-target">
                      <span className="request-target-label">requests</span>
                      <span className="request-account">{r.account_name}</span>
                      <code className="request-account-id">{r.account_id}</code>
                    </div>
                    {r.reason && <p className="request-reason">“{r.reason}”</p>}
                  </div>
                  <div className="request-actions">
                    <button
                      className="request-btn request-approve"
                      disabled={busyId === r.id}
                      onClick={() => decide(r.id, "approve")}
                    >
                      <Icon name="check" size={13} /> {busyId === r.id ? "Working…" : "Approve"}
                    </button>
                    <button
                      className="request-btn request-reject"
                      disabled={busyId === r.id}
                      onClick={() => decide(r.id, "reject")}
                    >
                      <Icon name="x" size={13} /> Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {decided.length > 0 && (
          <section className="requests-section">
            <h3 className="requests-title">
              History <span className="requests-count">{decided.length}</span>
            </h3>
            <div className="requests-table-wrap">
              <table className="requests-table">
                <thead>
                  <tr>
                    <th>Requester</th>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Decided by</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {decided.map((r) => (
                    <tr key={r.id}>
                      <td className="requests-td-strong">{r.requester_email}</td>
                      <td>
                        <span className="request-account">{r.account_name}</span>
                        <code className="request-account-id">{r.account_id}</code>
                      </td>
                      <td>
                        <span className={r.status === "approved" ? "allow-chip" : "deny-chip"}>
                          {r.status}
                        </span>
                      </td>
                      <td>{r.decided_by || "—"}</td>
                      <td className="requests-td-when">{when(r.decided_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </ModalFrame>
  );
}
