/**
 * lifecycle-telemetry.test.ts — Verifies trackSpawnConnected /
 * trackSpawnDeleted emit the right PostHog events and persist the
 * connect_count + last_connected_at metadata.
 */

import type { SpawnRecord } from "../history";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { isNumber, isString } from "@openrouter/spawn-shared";
// Import the real modules so we can spy on their exports without
// polluting the global module registry (mock.module contaminates
// other test files when running under --coverage).
import * as historyMod from "../history";
import { trackSpawnConnected, trackSpawnDeleted } from "../shared/lifecycle-telemetry";
import * as telemetryMod from "../shared/telemetry";

const savedMetadataCalls: Array<{
  entries: Record<string, string>;
  spawnId?: string;
}> = [];

const capturedEvents: Array<{
  event: string;
  properties: Record<string, unknown>;
}> = [];

// ── Helpers ─────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<SpawnRecord> = {}): SpawnRecord {
  return {
    id: "spawn-abc123",
    agent: "claude",
    cloud: "digitalocean",
    timestamp: "2026-04-13T12:00:00.000Z",
    connection: {
      ip: "10.0.0.1",
      user: "root",
      cloud: "digitalocean",
      metadata: {},
    },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("lifecycle-telemetry", () => {
  let saveMetadataSpy: ReturnType<typeof spyOn>;
  let captureEventSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    savedMetadataCalls.length = 0;
    capturedEvents.length = 0;

    saveMetadataSpy = spyOn(historyMod, "saveMetadata").mockImplementation(
      (entries: Record<string, string>, spawnId?: string) => {
        savedMetadataCalls.push({
          entries,
          spawnId,
        });
      },
    );
    captureEventSpy = spyOn(telemetryMod, "captureEvent").mockImplementation(
      (event: string, properties: Record<string, unknown>) => {
        capturedEvents.push({
          event,
          properties,
        });
      },
    );
  });

  afterEach(() => {
    saveMetadataSpy.mockRestore();
    captureEventSpy.mockRestore();
    savedMetadataCalls.length = 0;
    capturedEvents.length = 0;
  });

  describe("trackSpawnConnected", () => {
    it("starts the connect count at 1 when metadata is empty", () => {
      const record = makeRecord();
      const count = trackSpawnConnected(record);

      expect(count).toBe(1);
      expect(savedMetadataCalls).toHaveLength(1);
      expect(savedMetadataCalls[0].entries.connect_count).toBe("1");
      expect(savedMetadataCalls[0].spawnId).toBe("spawn-abc123");
    });

    it("increments an existing connect count", () => {
      const record = makeRecord({
        connection: {
          ip: "10.0.0.1",
          user: "root",
          cloud: "digitalocean",
          metadata: {
            connect_count: "4",
          },
        },
      });
      const count = trackSpawnConnected(record);

      expect(count).toBe(5);
      expect(savedMetadataCalls[0].entries.connect_count).toBe("5");
    });

    it("tolerates malformed connect_count by resetting to 1", () => {
      const record = makeRecord({
        connection: {
          ip: "10.0.0.1",
          user: "root",
          cloud: "digitalocean",
          metadata: {
            connect_count: "not-a-number",
          },
        },
      });
      const count = trackSpawnConnected(record);

      // Malformed parses to 0, +1 = 1. Never throws.
      expect(count).toBe(1);
    });

    it("updates last_connected_at to an ISO timestamp", () => {
      trackSpawnConnected(makeRecord());

      const ts = savedMetadataCalls[0].entries.last_connected_at;
      expect(ts).toBeDefined();
      // ISO 8601 format YYYY-MM-DDTHH:MM:SS.sssZ
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("emits spawn_connected event with spawn metadata", () => {
      const record = makeRecord();
      trackSpawnConnected(record);

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].event).toBe("spawn_connected");
      expect(capturedEvents[0].properties.spawn_id).toBe("spawn-abc123");
      expect(capturedEvents[0].properties.agent).toBe("claude");
      expect(capturedEvents[0].properties.cloud).toBe("digitalocean");
      expect(capturedEvents[0].properties.connect_count).toBe(1);
    });

    it("is a no-op for records without an id or connection", () => {
      const noId = makeRecord({
        id: undefined,
      });
      expect(trackSpawnConnected(noId)).toBe(0);
      expect(savedMetadataCalls).toHaveLength(0);
      expect(capturedEvents).toHaveLength(0);

      const noConn = makeRecord({
        connection: undefined,
      });
      expect(trackSpawnConnected(noConn)).toBe(0);
      expect(savedMetadataCalls).toHaveLength(0);
      expect(capturedEvents).toHaveLength(0);
    });
  });

  describe("trackSpawnDeleted", () => {
    it("emits spawn_deleted with lifetime_hours computed from timestamp", () => {
      // Record created 3 hours ago. With `new Date()` in the helper we can't
      // easily mock the clock here, so we assert on a loose-but-correct
      // range (3h +/- a minute).
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const record = makeRecord({
        timestamp: threeHoursAgo,
      });

      trackSpawnDeleted(record);

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].event).toBe("spawn_deleted");
      const rawLifetime = capturedEvents[0].properties.lifetime_hours;
      const lifetime = isNumber(rawLifetime) ? rawLifetime : 0;
      expect(lifetime).toBeGreaterThanOrEqual(2.98);
      expect(lifetime).toBeLessThanOrEqual(3.02);
    });

    it("reports the final connect count", () => {
      const record = makeRecord({
        connection: {
          ip: "10.0.0.1",
          user: "root",
          cloud: "digitalocean",
          metadata: {
            connect_count: "7",
          },
        },
      });
      trackSpawnDeleted(record);

      expect(capturedEvents[0].properties.connect_count).toBe(7);
    });

    it("clamps negative lifetimes to 0 (corrupt clock / timestamp)", () => {
      const futureTimestamp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const record = makeRecord({
        timestamp: futureTimestamp,
      });

      trackSpawnDeleted(record);

      expect(capturedEvents[0].properties.lifetime_hours).toBe(0);
    });

    it("is a no-op for records without an id", () => {
      trackSpawnDeleted(
        makeRecord({
          id: undefined,
        }),
      );
      expect(capturedEvents).toHaveLength(0);
    });

    it("includes spawn_id, agent, cloud, and date on every event", () => {
      trackSpawnDeleted(makeRecord());

      const props = capturedEvents[0].properties;
      expect(props.spawn_id).toBe("spawn-abc123");
      expect(props.agent).toBe("claude");
      expect(props.cloud).toBe("digitalocean");
      expect(isString(props.date)).toBe(true);
      expect(props.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});
