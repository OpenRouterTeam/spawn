import * as p from "@clack/prompts";
import pc from "picocolors";
import { listBackups, restoreBackups } from "../local/backup.js";

/**
 * Restore agent config files spawn wrote to the user's machine in `local`
 * mode back to their pre-spawn state. Files spawn created from scratch are
 * removed; pre-existing files are overwritten with their original contents.
 *
 * @param agent — optional agent key to filter the restore (e.g. "claude").
 */
export async function cmdLocalRestore(agent?: string): Promise<void> {
  p.intro(pc.bold("Restore local agent configs"));

  const entries = listBackups();
  if (entries.length === 0) {
    p.log.info("Nothing to restore — spawn has no local config snapshots on this machine.");
    p.outro("Done");
    return;
  }

  const filtered = agent ? entries.filter((e) => e.agent === agent) : entries;
  if (filtered.length === 0) {
    p.log.info(`No local snapshots found for agent ${pc.bold(agent ?? "")}.`);
    const tracked = [
      ...new Set(entries.map((e) => e.agent)),
    ].sort();
    if (tracked.length > 0) {
      p.log.info(`Tracked agents: ${tracked.join(", ")}`);
    }
    p.outro("Done");
    return;
  }

  p.log.step("The following will be reverted:");
  for (const e of filtered) {
    const verb = e.existed ? "restore" : "remove";
    p.log.info(`  ${verb}: ${e.destPath} ${pc.dim(`(${e.agent})`)}`);
  }

  const confirmed = await p.confirm({
    message: agent
      ? `Restore ${filtered.length} file(s) for ${pc.bold(agent)}?`
      : `Restore ${filtered.length} file(s) across all tracked agents?`,
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.outro("Cancelled");
    return;
  }

  const summary = restoreBackups(agent);

  if (summary.restored.length > 0) {
    p.log.success(`Restored ${summary.restored.length} file(s) to pre-spawn state.`);
  }
  if (summary.removed.length > 0) {
    p.log.success(`Removed ${summary.removed.length} file(s) spawn created.`);
  }
  if (summary.failed.length > 0) {
    p.log.warn(`${summary.failed.length} file(s) could not be restored:`);
    for (const dest of summary.failed) {
      p.log.warn(`  ${dest}`);
    }
  }
  if (summary.restored.length === 0 && summary.removed.length === 0 && summary.failed.length === 0) {
    p.log.info("Nothing to do — files already match their pre-spawn state.");
  }

  p.outro("spawn local configs reverted");
}
