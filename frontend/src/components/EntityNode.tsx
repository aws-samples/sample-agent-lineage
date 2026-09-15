import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { NODE_TYPE_META, type GraphNode } from "../types";
import { Icon } from "./Icon";

export type EntityFlowNode = Node<{ entity: GraphNode }, "entity">;

/** Engine / hosting / provider / kind — whichever the entity declares first,
 *  falling back to the AgentCore Registry record type (e.g. for skills). */
function engineLabel(entity: GraphNode): string {
  const f = entity.facets as Record<string, unknown>;
  const direct = f.engine ?? f.hosting ?? f.provider ?? f.kind;
  if (direct) return String(direct);
  const reg = f.registry as Record<string, unknown> | undefined;
  return reg?.record_type ? String(reg.record_type) : "";
}

export function EntityNode({ data, selected }: NodeProps<EntityFlowNode>) {
  const { entity } = data;
  const meta = NODE_TYPE_META[entity.node_type];
  const engine = engineLabel(entity);
  return (
    <div
      className="entity-node"
      style={{
        borderColor: meta.color,
        boxShadow: selected ? `0 0 0 3px ${meta.color}55` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="entity-node-header" style={{ background: meta.color }}>
        <Icon name={meta.icon} size={11} /> {meta.label}
      </div>
      <div className="entity-node-name" title={entity.description}>
        {entity.name}
      </div>
      {engine && <div className="entity-node-engine">{engine}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
