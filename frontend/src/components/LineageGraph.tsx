import { useMemo } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutLR } from "../layout";
import type { Graph, GraphNode } from "../types";
import { EntityNode } from "./EntityNode";

const nodeTypes = { entity: EntityNode };

const EDGE_COLOR: Record<string, string> = {
  declared: "#94a3b8",
  observed: "#2563eb",
  both: "#059669",
};

interface Props {
  graph: Graph;
  onSelect: (node: GraphNode | null) => void;
}

export function LineageGraph({ graph, onSelect }: Props) {
  const { nodes, edges } = useMemo(() => {
    const flowNodes: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: "entity",
      position: { x: 0, y: 0 },
      data: { entity: n },
    }));
    const flowEdges: Edge[] = graph.edges.map((e) => {
      // Edges with Cedar denials get flagged red regardless of origin.
      const denyCount = Number(e.facets.cedar_deny_count ?? 0);
      const color = denyCount > 0 ? "#dc2626" : (EDGE_COLOR[e.origin] ?? "#94a3b8");
      let label = e.call_count > 0 ? `${e.edge_type} (${e.call_count})` : e.edge_type;
      if (denyCount > 0) label += ` ⚠ ${denyCount} denied`;
      return {
        id: String(e.id),
        source: e.source,
        target: e.target,
        label,
        animated: e.origin !== "declared",
        style: {
          stroke: color,
          strokeDasharray: e.origin === "declared" ? "6 4" : undefined,
        },
        labelStyle: { fontSize: 10, fill: denyCount > 0 ? "#dc2626" : "#475569" },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      };
    });
    return { nodes: layoutLR(flowNodes, flowEdges), edges: flowEdges };
  }, [graph]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.2}
      nodesConnectable={false}
      onNodeClick={(_, node) => onSelect((node.data as { entity: GraphNode }).entity)}
      onPaneClick={() => onSelect(null)}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} />
      <Controls />
    </ReactFlow>
  );
}
