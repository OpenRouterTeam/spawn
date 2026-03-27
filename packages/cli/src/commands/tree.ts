// commands/tree.ts — `spawn tree` command: shows the full recursive spawn tree

import type { SpawnRecord } from "../history.js";
import type { Manifest } from "../manifest.js";

import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadHistory } from "../history.js";
import { loadManifest } from "../manifest.js";
import { asyncTryCatch } from "../shared/result.js";
import { formatRelativeTime } from "./list.js";
import { resolveDisplayName } from "./shared.js";

interface TreeNode {
  record: SpawnRecord;
  children: TreeNode[];
}

/** Build a tree from all history records using parent_id. */
function buildFullTree(records: SpawnRecord[]): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const r of records) {
    nodeMap.set(r.id, {
      record: r,
      children: [],
    });
  }

  for (const r of records) {
    const node = nodeMap.get(r.id);
    if (!node) {
      continue;
    }
    if (r.parent_id && nodeMap.has(r.parent_id)) {
      nodeMap.get(r.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/** Render a tree node to console with tree-drawing characters. */
function printNode(node: TreeNode, manifest: Manifest | null, prefix: string, isLast: boolean, isRoot: boolean): void {
  const r = node.record;
  const name = r.name || r.connection?.server_name || r.id.slice(0, 8);
  const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
  const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
  const time = formatRelativeTime(r.timestamp);
  const depthLabel = r.depth !== undefined ? pc.dim(` depth=${r.depth}`) : "";
  const deletedLabel = r.connection?.deleted ? pc.red(" [deleted]") : "";

  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const line = `${prefix}${connector}${pc.bold(name)}  ${pc.dim(`${agentDisplay}/${cloudDisplay}`)}  ${pc.dim(time)}${depthLabel}${deletedLabel}`;
  console.log(line);

  const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
  for (let i = 0; i < node.children.length; i++) {
    printNode(node.children[i], manifest, childPrefix, i === node.children.length - 1, false);
  }
}

/** Count total nodes in a tree. */
function countNodes(nodes: TreeNode[]): number {
  let count = 0;
  for (const n of nodes) {
    count += 1;
    count += countNodes(n.children);
  }
  return count;
}

export async function cmdTree(jsonOutput?: boolean): Promise<void> {
  const records = loadHistory();

  if (records.length === 0) {
    p.log.info("No spawn history found.");
    p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to create your first spawn.`);
    return;
  }

  const manifestResult = await asyncTryCatch(() => loadManifest());
  const manifest: Manifest | null = manifestResult.ok ? manifestResult.data : null;

  const roots = buildFullTree(records);

  if (jsonOutput) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  console.log();
  for (let i = 0; i < roots.length; i++) {
    printNode(roots[i], manifest, "", i === roots.length - 1, true);
    if (i < roots.length - 1) {
      console.log();
    }
  }
  console.log();

  const total = countNodes(roots);
  const treeCount = roots.filter((r) => r.children.length > 0).length;
  if (treeCount > 0) {
    p.log.info(`${total} spawn(s) across ${treeCount} tree(s)`);
  } else {
    p.log.info(`${total} spawn(s), no parent-child relationships`);
  }
}
