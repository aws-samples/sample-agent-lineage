import { useState } from "react";
import { syncAws, type AwsSyncResult } from "../api";

interface Props {
  onClose: () => void;
  onSynced: () => void;
}

/** Connect an AWS account: region + local profile or assumable read-only role.
 *  The account ID is discovered via STS; synced nodes are namespaced account/region. */
export function AwsConnectModal({ onClose, onSynced }: Props) {
  const [region, setRegion] = useState("us-east-1");
  const [profile, setProfile] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AwsSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await syncAws({
        region,
        profile: profile || undefined,
        role_arn: roleArn || undefined,
      });
      setResult(res);
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal aws-modal"
        role="dialog"
        aria-label="Connect AWS account"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2>Connect AWS account</h2>
            <p className="hint">
              Pulls AgentCore Runtime agents, Gateways + targets, Identity,
              Bedrock Guardrails and Agent Registry records (read-only). Provide a
              local AWS profile or a role ARN to assume; the account ID is
              discovered automatically.
            </p>
          </div>
          <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="aws-form">
          <label>
            Region
            <input value={region} onChange={(e) => setRegion(e.target.value)} />
          </label>
          <label>
            AWS profile <small>(optional — default credentials chain if empty)</small>
            <input
              value={profile}
              placeholder="e.g. platform-readonly"
              onChange={(e) => setProfile(e.target.value)}
            />
          </label>
          <label>
            Role ARN to assume <small>(optional)</small>
            <input
              value={roleArn}
              placeholder="arn:aws:iam::123456789012:role/agent-lineage-readonly"
              onChange={(e) => setRoleArn(e.target.value)}
            />
          </label>
          <button className="focus-btn aws-sync-btn" disabled={busy} onClick={run}>
            {busy ? "Syncing…" : "Sync account"}
          </button>
        </div>

        {error && <div className="error aws-result">{error}</div>}

        {result && (
          <div className="aws-result">
            <div className="aws-result-head">
              Synced <b>{result.account_id}</b> / {result.region} → namespace{" "}
              <code>{result.namespace}</code>
            </div>
            <table className="cost-table">
              <thead>
                <tr><th>Module</th><th>Result</th></tr>
              </thead>
              <tbody>
                {Object.entries(result.modules).map(([name, m]) => (
                  <tr key={name}>
                    <td>{name.replace(/_/g, " ")}</td>
                    <td>
                      {m.ok ? (
                        <span className="allow-chip">
                          {Object.entries(m)
                            .filter(([k]) => k !== "ok")
                            .map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`)
                            .join(", ") || "ok"}
                        </span>
                      ) : (
                        <span className="deny-chip" title={String(m.error)}>
                          {String(m.error).slice(0, 80)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
