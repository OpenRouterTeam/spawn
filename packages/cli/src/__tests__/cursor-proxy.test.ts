/**
 * cursor-proxy.test.ts — Tests for the Cursor CLI → OpenRouter proxy.
 * Covers: protobuf encoding, ConnectRPC framing, model details, deployment functions.
 */

import { describe, expect, it, mock } from "bun:test";
import { tryCatch } from "../shared/result";

// ── Protobuf helpers (mirrors the proxy script's functions) ─────────────────

function ev(v: number): Buffer {
  const b: number[] = [];
  while (v > 0x7f) {
    b.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  b.push(v & 0x7f);
  return Buffer.from(b);
}

function es(f: number, s: string): Buffer {
  const sb = Buffer.from(s);
  return Buffer.concat([
    ev((f << 3) | 2),
    ev(sb.length),
    sb,
  ]);
}

function em(f: number, p: Buffer): Buffer {
  return Buffer.concat([
    ev((f << 3) | 2),
    ev(p.length),
    p,
  ]);
}

// ConnectRPC frame
function cf(p: Buffer): Buffer {
  const f = Buffer.alloc(5 + p.length);
  f[0] = 0x00;
  f.writeUInt32BE(p.length, 1);
  p.copy(f, 5);
  return f;
}

// ConnectRPC trailer
function ct(): Buffer {
  const j = Buffer.from("{}");
  const t = Buffer.alloc(5 + j.length);
  t[0] = 0x02;
  t.writeUInt32BE(j.length, 1);
  j.copy(t, 5);
  return t;
}

// AgentServerMessage.InteractionUpdate.TextDeltaUpdate
function tdf(text: string): Buffer {
  return cf(em(1, em(1, es(1, text))));
}

// AgentServerMessage.InteractionUpdate.TurnEndedUpdate
function tef(): Buffer {
  return cf(
    em(
      1,
      em(
        14,
        Buffer.from([
          8,
          10,
          16,
          5,
        ]),
      ),
    ),
  );
}

// ModelDetails
function bmd(id: string, name: string): Buffer {
  return Buffer.concat([
    es(1, id),
    es(3, id),
    es(4, name),
    es(5, name),
  ]);
}

// Extract strings from protobuf
function xstr(buf: Buffer, out: string[]): void {
  let o = 0;
  while (o < buf.length) {
    let t = 0;
    let s = 0;
    while (o < buf.length) {
      const b = buf[o++];
      t |= (b & 0x7f) << s;
      s += 7;
      if (!(b & 0x80)) {
        break;
      }
    }
    const wt = t & 7;
    if (wt === 0) {
      while (o < buf.length && buf[o++] & 0x80) {
        /* consume varint */
      }
    } else if (wt === 2) {
      let len = 0;
      let ls = 0;
      while (o < buf.length) {
        const b = buf[o++];
        len |= (b & 0x7f) << ls;
        ls += 7;
        if (!(b & 0x80)) {
          break;
        }
      }
      const d = buf.slice(o, o + len);
      o += len;
      const st = d.toString("utf8");
      if (/^[\x20-\x7e]+$/.test(st)) {
        out.push(st);
      } else {
        const r = tryCatch(() => xstr(d, out));
        if (!r.ok) {
          /* ignore nested parse errors */
        }
      }
    } else {
      break;
    }
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("protobuf encoding", () => {
  it("encodes varint correctly", () => {
    expect(ev(0)).toEqual(
      Buffer.from([
        0,
      ]),
    );
    expect(ev(1)).toEqual(
      Buffer.from([
        1,
      ]),
    );
    expect(ev(127)).toEqual(
      Buffer.from([
        127,
      ]),
    );
    expect(ev(128)).toEqual(
      Buffer.from([
        0x80,
        0x01,
      ]),
    );
    expect(ev(300)).toEqual(
      Buffer.from([
        0xac,
        0x02,
      ]),
    );
  });

  it("encodes string fields", () => {
    const buf = es(1, "hello");
    // field 1, wire type 2 (length-delimited) = tag 0x0a
    expect(buf[0]).toBe(0x0a);
    // length = 5
    expect(buf[1]).toBe(5);
    // string content
    expect(buf.slice(2).toString("utf8")).toBe("hello");
  });

  it("encodes nested messages", () => {
    const inner = es(1, "test");
    const outer = em(2, inner);
    // field 2, wire type 2 = tag 0x12
    expect(outer[0]).toBe(0x12);
    // length of inner message
    expect(outer[1]).toBe(inner.length);
  });
});

describe("ConnectRPC framing", () => {
  it("wraps payload in a frame with 5-byte header", () => {
    const payload = Buffer.from("test");
    const frame = cf(payload);
    expect(frame.length).toBe(5 + payload.length);
    expect(frame[0]).toBe(0x00); // no compression
    expect(frame.readUInt32BE(1)).toBe(payload.length);
    expect(frame.slice(5).toString()).toBe("test");
  });

  it("creates a JSON trailer frame", () => {
    const trailer = ct();
    expect(trailer[0]).toBe(0x02); // JSON type
    expect(trailer.readUInt32BE(1)).toBe(2); // length of "{}"
    expect(trailer.slice(5).toString()).toBe("{}");
  });
});

describe("AgentServerMessage encoding", () => {
  it("encodes text delta update", () => {
    const frame = tdf("Hello world");
    // Should be a ConnectRPC frame (starts with 0x00)
    expect(frame[0]).toBe(0x00);
    // Payload should contain the text
    const payload = frame.slice(5);
    const strings: string[] = [];
    xstr(payload, strings);
    expect(strings).toContain("Hello world");
  });

  it("encodes turn ended update", () => {
    const frame = tef();
    expect(frame[0]).toBe(0x00);
    // Payload should be non-empty (contains token counts)
    const payloadLen = frame.readUInt32BE(1);
    expect(payloadLen).toBeGreaterThan(0);
  });
});

describe("ModelDetails encoding", () => {
  it("encodes model with all required fields", () => {
    const model = bmd("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6");
    const strings: string[] = [];
    xstr(model, strings);
    expect(strings).toContain("anthropic/claude-sonnet-4-6");
    expect(strings).toContain("Claude Sonnet 4.6");
  });

  it("encodes model list response", () => {
    const models = [
      [
        "anthropic/claude-sonnet-4-6",
        "Claude Sonnet 4.6",
      ],
      [
        "openai/gpt-5.4",
        "GPT-5.4",
      ],
    ];
    const response = Buffer.concat(models.map(([id, name]) => em(1, bmd(id, name))));
    const strings: string[] = [];
    xstr(response, strings);
    expect(strings).toContain("anthropic/claude-sonnet-4-6");
    expect(strings).toContain("openai/gpt-5.4");
  });
});

describe("protobuf string extraction", () => {
  it("extracts strings from nested protobuf", () => {
    // Simulate a request with user message
    const msg = em(
      1,
      Buffer.concat([
        es(1, "say hello"),
        es(2, "uuid-1234-5678"),
      ]),
    );
    const strings: string[] = [];
    xstr(msg, strings);
    expect(strings).toContain("say hello");
    expect(strings).toContain("uuid-1234-5678");
  });

  it("skips binary data", () => {
    const binary = Buffer.from([
      0x0a,
      0x03,
      0xff,
      0xfe,
      0xfd,
    ]);
    const strings: string[] = [];
    xstr(binary, strings);
    expect(strings.length).toBe(0);
  });
});

describe("setupCursorProxy", () => {
  it("calls runner.runServer for caddy install and proxy deployment", async () => {
    const runServerCalls: string[] = [];
    const runner = {
      runServer: mock(async (cmd: string) => {
        runServerCalls.push(cmd.slice(0, 50));
      }),
      uploadFile: mock(async () => {}),
      downloadFile: mock(async () => {}),
    };

    const { setupCursorProxy: setup } = await import("../shared/cursor-proxy");
    await setup(runner);

    // Should have called runServer multiple times (caddy install, deploy, hosts, trust)
    expect(runServerCalls.length).toBeGreaterThanOrEqual(3);
    // Should include caddy install check
    expect(runServerCalls.some((c) => c.includes("caddy"))).toBe(true);
    // Should include hosts configuration
    expect(runServerCalls.some((c) => c.includes("hosts") || c.includes("cursor.sh"))).toBe(true);
  });
});

describe("startCursorProxy", () => {
  it("calls runner.runServer with port checks", async () => {
    const runServerCalls: string[] = [];
    const runner = {
      runServer: mock(async (cmd: string) => {
        runServerCalls.push(cmd);
      }),
      uploadFile: mock(async () => {}),
      downloadFile: mock(async () => {}),
    };

    const { startCursorProxy: start } = await import("../shared/cursor-proxy");
    await start(runner);

    // Should include port checks for 443, 18644, 18645
    const fullCmd = runServerCalls.join(" ");
    expect(fullCmd.includes("18644")).toBe(true);
    expect(fullCmd.includes("18645")).toBe(true);
    expect(fullCmd.includes("443")).toBe(true);
  });
});
