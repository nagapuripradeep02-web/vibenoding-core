/**
 * V3.0 Workflow Graph Analysis
 * Compute upstream dependencies for each node
 */

import type { N8nWorkflow, N8nConnections, N8nNode } from './types';

/**
 * Build a map from node name to node id
 */
function buildNodeNameToIdMap(nodes: N8nNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) {
    map.set(node.name, node.id);
  }
  return map;
}

/**
 * Compute upstream dependencies for each node
 * Returns a Map where key is nodeId and value is array of upstream nodeIds
 * 
 * n8n connections format:
 * {
 *   "SourceNodeName": {
 *     "main": [
 *       [ { "node": "TargetNodeName", "type": "main", "index": 0 } ]
 *     ]
 *   }
 * }
 * 
 * This means SourceNode -> TargetNode, so TargetNode's upstream includes SourceNode
 */
export function computeUpstreamDependencies(workflow: N8nWorkflow): Map<string, string[]> {
  const nodes = workflow.nodes || [];
  const connections = workflow.connections || {};
  
  // Map node name -> node id
  const nameToId = buildNodeNameToIdMap(nodes);
  
  // Initialize result: each node starts with empty upstream list
  const upstreamMap = new Map<string, string[]>();
  for (const node of nodes) {
    upstreamMap.set(node.id, []);
  }
  
  // Parse connections: for each source node, find all target nodes
  // Target nodes get the source as an upstream dependency
  for (const [sourceNodeName, outputTypes] of Object.entries(connections)) {
    const sourceNodeId = nameToId.get(sourceNodeName);
    if (!sourceNodeId) continue;
    
    // Iterate through output types (usually "main")
    for (const [, connectionArrays] of Object.entries(outputTypes as N8nConnections[string])) {
      if (!Array.isArray(connectionArrays)) continue;
      
      // Each array represents connections from an output index
      for (const connectionArray of connectionArrays) {
        if (!Array.isArray(connectionArray)) continue;
        
        for (const conn of connectionArray) {
          if (!conn || typeof conn.node !== 'string') continue;
          
          const targetNodeName = conn.node;
          const targetNodeId = nameToId.get(targetNodeName);
          
          if (targetNodeId) {
            const upstreamList = upstreamMap.get(targetNodeId) || [];
            if (!upstreamList.includes(sourceNodeId)) {
              upstreamList.push(sourceNodeId);
              upstreamMap.set(targetNodeId, upstreamList);
            }
          }
        }
      }
    }
  }
  
  return upstreamMap;
}

/**
 * Get all downstream nodes for a given node (nodes that depend on it)
 */
export function computeDownstreamDependencies(workflow: N8nWorkflow): Map<string, string[]> {
  const nodes = workflow.nodes || [];
  const connections = workflow.connections || {};
  
  const nameToId = buildNodeNameToIdMap(nodes);
  
  // Initialize result
  const downstreamMap = new Map<string, string[]>();
  for (const node of nodes) {
    downstreamMap.set(node.id, []);
  }
  
  // Parse connections: source -> target means source has target as downstream
  for (const [sourceNodeName, outputTypes] of Object.entries(connections)) {
    const sourceNodeId = nameToId.get(sourceNodeName);
    if (!sourceNodeId) continue;
    
    for (const [, connectionArrays] of Object.entries(outputTypes as N8nConnections[string])) {
      if (!Array.isArray(connectionArrays)) continue;
      
      for (const connectionArray of connectionArrays) {
        if (!Array.isArray(connectionArray)) continue;
        
        for (const conn of connectionArray) {
          if (!conn || typeof conn.node !== 'string') continue;
          
          const targetNodeId = nameToId.get(conn.node);
          if (targetNodeId) {
            const downstreamList = downstreamMap.get(sourceNodeId) || [];
            if (!downstreamList.includes(targetNodeId)) {
              downstreamList.push(targetNodeId);
              downstreamMap.set(sourceNodeId, downstreamList);
            }
          }
        }
      }
    }
  }
  
  return downstreamMap;
}

/**
 * Identify trigger nodes (nodes with no upstream dependencies)
 */
export function findTriggerNodes(workflow: N8nWorkflow): string[] {
  const upstreamMap = computeUpstreamDependencies(workflow);
  const triggerNodeIds: string[] = [];
  
  for (const [nodeId, upstreamNodes] of upstreamMap) {
    if (upstreamNodes.length === 0) {
      triggerNodeIds.push(nodeId);
    }
  }
  
  return triggerNodeIds;
}

