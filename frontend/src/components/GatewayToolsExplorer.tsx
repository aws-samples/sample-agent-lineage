import type { Graph, GraphNode } from "../types";

interface Props {
  gateway: GraphNode;
  graph: Graph;
  onClose: () => void;
}

/** Full-screen catalog of every tool a gateway routes to: hosting, MCP tool
 *  definitions, observed traffic and downstream resource access. */
export function GatewayToolsExplorer({ gateway, graph, onClose }: Props) {
  const routed = graph.edges
    .filter((e) => e.source === gateway.id && e.edge_type === "ROUTES_TO")
    .map((e) => ({
      edge: e,
      tool: graph.nodes.find((n) => n.id === e.target),
    }))
    .filter((r): r is { edge: (typeof r)["edge"]; tool: GraphNode } => r.tool !== undefined);

  const nameOf = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={`Tools behind ${gateway.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2>🔧 Tools behind {gateway.name}</h2>
            <p className="hint">
              Everything this gateway can provide access to: tool interfaces from the
              registry, hosting targets, observed traffic and downstream resources.
            </p>
          </div>
          <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="runs-toolbar">
          <span className="runs-total">{routed.length} tools</span>
        </div>

        <div className="runs-table-wrap">
          <table className="runs-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Hosting / target</th>
                <th>Interface (tool definitions)</th>
                <th>Traffic</th>
                <th>Accesses</th>
              </tr>
            </thead>
            <tbody>
              {routed.length === 0 && (
                <tr><td colSpan={5} className="runs-empty">no routed tools</td></tr>
              )}
              {routed.map(({ edge, tool }) => {
                const reg = tool.facets.registry as Record<string, unknown> | undefined;
                const defs = (reg?.tool_definitions as string[] | undefined) ?? [];
                const hosting = String(
                  tool.facets.hosting ?? edge.facets.target_type ?? "—",
                );
                const accesses = graph.edges.filter(
                  (a) => a.source === tool.id && a.edge_type === "ACCESSES",
                );
                return (
                  <tr key={tool.id}>
                    <td>
                      <b>{tool.name}</b>
                      {tool.description && (
                        <div className="decision-meta">{tool.description}</div>
                      )}
                    </td>
                    <td>{hosting}</td>
                    <td>
                      {defs.length > 0 ? (
                        <div className="gw-tool-defs">
                          {defs.map((d) => (
                            <code key={d} className="gw-tool-def">{d}</code>
                          ))}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {edge.call_count > 0 ? `${edge.call_count} calls` : "unused"}
                    </td>
                    <td>
                      {accesses.length > 0
                        ? accesses.map((a) => (
                            <span key={a.id} className="tag">🗄️ {nameOf(a.target)}</span>
                          ))
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
