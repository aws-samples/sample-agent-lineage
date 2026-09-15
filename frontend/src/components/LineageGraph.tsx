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
  // Control-room signal vocabulary: amber is the one committed colour and it
  // means "needs attention" — undeclared access is the product's alarm.
  // Healthy (both) recedes to a quiet green; declared-only is a grey trace.
  declared: "#6b7788",
  observed: "#f5a524",
  both: "#2fbf8f",
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
      const color = denyCount > 0 ? "#f0506e" : (EDGE_COLOR[e.origin] ?? "#6b7788");
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
          strokeWidth: e.origin === "observed" || denyCount > 0 ? 2 : 1.5,
          strokeDasharray: e.origin === "declared" ? "6 4" : undefined,
        },
        labelStyle: {
          fontSize: 10,
          fill: denyCount > 0 ? "#f0506e" : e.origin === "observed" ? "#f5a524" : undefined,
        },
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
      <Background gap={24} size={1} className="graph-bg" />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
}
