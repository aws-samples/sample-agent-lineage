import { useMemo } from "react";
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { layoutLR } from "../layout";
import { NODE_TYPE_META, type NodeType, type RunTimeline } from "../types";
import { Icon, type IconName } from "./Icon";

interface TrajData {
  icon: IconName;
  color: string;
  name: string;
  sub: string;
  [key: string]: unknown;
}

type TrajFlowNode = Node<TrajData, "traj">;

function TrajNode({ data }: NodeProps<TrajFlowNode>) {
  return (
    <div className="traj-node" style={{ borderColor: data.color }}>
      <Handle type="target" position={Position.Left} />
      <div className="traj-node-name">
        <Icon name={data.icon} size={12} style={{ color: data.color }} /> {data.name}
      </div>
      {data.sub && <div className="traj-node-sub">{data.sub}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { traj: TrajNode };

interface Agg {
  type: NodeType | "start" | "end";
  name: string;
  count: number;
  tokensIn: number;
  tokensOut: number;
  denied: number;
}

/** Aggregated LangGraph-style view of one run: START -> agent(s) -> the tools,
 *  LLMs, gateways and resources they touched -> END, with call counts. */
export function RunTrajectoryGraph({ timeline }: { timeline: RunTimeline }) {
  const { nodes, edges } = useMemo(() => {
    const entities = new Map<string, Agg>();
    const links = new Map<string, { count: number; denied: number }>();

    const touch = (type: Agg["type"], name: string): string => {
      const id = `${type}:${name}`;
      if (!entities.has(id)) {
        entities.set(id, { type, name, count: 0, tokensIn: 0, tokensOut: 0, denied: 0 });
      }
      return id;
    };
    const link = (src: string, dst: string, denied = 0) => {
      const key = `${src}->${dst}`;
      const cur = links.get(key) ?? { count: 0, denied: 0 };
      cur.count += 1;
      cur.denied += denied;
      links.set(key, cur);
    };

    let firstAgent: string | null = null;
    let finalState = "COMPLETE";
    let failMessage = "";
    const failedIds = new Set<string>();
    for (const s of timeline.steps) {
      const agentId = touch("agent", s.agent);
      if (!firstAgent) firstAgent = agentId;
      if (s.event_type === "FAIL") finalState = "FAIL";
      if (s.error) {
        // where: "tool:x" | "llm:y" | "agent" — matches our entity id scheme.
        const where = s.error.where ?? "agent";
        failedIds.add(where === "agent" ? agentId : where);
        if (s.error.message && !failMessage) failMessage = s.error.message;
      }
      const rep = s.repeat ?? 1;

      for (const l of s.llms) {
        const id = touch("llm", l.name);
        const e = entities.get(id)!;
        e.count += rep;
        e.tokensIn += l.input_tokens * rep;
        e.tokensOut += l.output_tokens * rep;
        link(agentId, id);
      }
      for (const t of s.tools) {
        const id = touch("tool", t);
        entities.get(id)!.count += rep;
        link(agentId, id);
      }
      for (const g of s.gateway_calls) {
        const gwId = touch("gateway", g.gateway);
        entities.get(gwId)!.count += rep;
        const denied = g.decision === "DENY" ? rep : 0;
        entities.get(gwId)!.denied += denied;
        link(agentId, gwId, denied);
        if (g.decision !== "DENY") {
          const toolId = touch("tool", g.tool);
          entities.get(toolId)!.count += rep;
          link(gwId, toolId);
        }
      }
      for (const r of s.resources) {
        const id = touch("resource", r);
        entities.get(id)!.count += rep;
        link(agentId, id);
      }
      for (const sa of s.sub_agents) {
        const id = touch("agent", sa);
        entities.get(id)!.count += rep;
        link(agentId, id);
      }
    }

    // START / END pseudo-nodes around the root agent.
    if (firstAgent) {
      entities.set("start:__", { type: "start", name: "START", count: 0, tokensIn: 0, tokensOut: 0, denied: 0 });
      entities.set("end:__", { type: "end", name: finalState === "FAIL" ? "FAIL" : "END", count: 0, tokensIn: 0, tokensOut: 0, denied: 0 });
      links.set(`start:__->${firstAgent}`, { count: 1, denied: 0 });
      links.set(`${firstAgent}->end:__`, { count: 1, denied: 0 });
    }

    const flowNodes: Node[] = [...entities.entries()].map(([id, e]) => {
      const meta: { icon: IconName; color: string } =
        e.type === "start"
          ? { icon: "signal", color: "#059669" }
          : e.type === "end"
            ? { icon: e.name === "FAIL" ? "x" : "check", color: e.name === "FAIL" ? "#dc2626" : "#334155" }
            : NODE_TYPE_META[e.type as NodeType];
      const failed = failedIds.has(id);
      const subParts: string[] = [];
      if (e.count > 0) subParts.push(`${e.count} call${e.count > 1 ? "s" : ""}`);
      if (e.tokensIn || e.tokensOut) {
        subParts.push(`${e.tokensIn.toLocaleString()}/${e.tokensOut.toLocaleString()} tok`);
      }
      if (e.denied > 0) subParts.push(`⚠ ${e.denied} denied`);
      if (failed) subParts.push("⚠ failed");
      if (e.type === "end" && e.name === "FAIL" && failMessage) {
        subParts.push(failMessage.slice(0, 60));
      }
      return {
        id,
        type: "traj",
        position: { x: 0, y: 0 },
        data: {
          icon: meta.icon,
          color: failed ? "#dc2626" : meta.color,
          name: e.name,
          sub: subParts.join(" · "),
        },
      };
    });

    const flowEdges: Edge[] = [...links.entries()].map(([key, l]) => {
      const [source, target] = key.split("->");
      const color = l.denied > 0 ? "#dc2626" : "#64748b";
      return {
        id: key,
        source,
        target,
        animated: true,
        label: l.count > 1 ? `×${l.count}` : undefined,
        style: { stroke: color },
        labelStyle: { fontSize: 10, fill: color },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      };
    });

    return { nodes: layoutLR(flowNodes, flowEdges), edges: flowEdges };
  }, [timeline]);

  return (
    <div className="traj-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
      </ReactFlow>
    </div>
  );
}
