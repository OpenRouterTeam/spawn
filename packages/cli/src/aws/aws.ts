// aws/aws.ts — Core AWS Lightsail provider: auth, provisioning, SSH execution

import type { VMConnection } from "../history.js";
import type { CloudInitTier } from "../shared/agents";

import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as v from "valibot";
import { handleBillingError, isBillingError, showNonBillingError } from "../shared/billing-guidance";
import { getPackagesForTier, NODE_INSTALL_CMD, needsBun, needsNode } from "../shared/cloud-init";
import { parseJsonWith } from "../shared/parse";
import { getSpawnCloudConfigPath } from "../shared/paths";
import { asyncTryCatch, isFileError, tryCatch, tryCatchIf, unwrapOr } from "../shared/result.js";
import {
  killWithTimeout,
  SSH_BASE_OPTS,
  SSH_INTERACTIVE_OPTS,
  waitForSsh as sharedWaitForSsh,
  sleep,
  spawnInteractive,
} from "../shared/ssh";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys";
import { getErrorMessage } from "../shared/type-guards";
import {
  getServerNameFromEnv,
  jsonEscape,
  logError,
  logInfo,
  logStep,
  logStepDone,
  logStepInline,
  logWarn,
  prompt,
  promptSpawnNameShared,
  sanitizeTermValue,
  selectFromList,
  validateRegionName,
} from "../shared/ui";

const DASHBOARD_URL = "https://lightsail.aws.amazon.com/";

// ─── Credential Cache ────────────────────────────────────────────────────────

export function getAwsConfigPath(): string {
  return getSpawnCloudConfigPath("aws");
}

const AwsCredsSchema = v.object({
  accessKeyId: v.string(),
  secretAccessKey: v.string(),
  region: v.optional(v.string()),
});

export async function saveCredsToConfig(accessKeyId: string, secretAccessKey: string, region: string): Promise<void> {
  const configPath = getAwsConfigPath();
  const dir = configPath.replace(/\/[^/]+$/, "");
  mkdirSync(dir, {
    recursive: true,
    mode: 0o700,
  });
  const payload = `{\n  "accessKeyId": ${jsonEscape(accessKeyId)},\n  "secretAccessKey": ${jsonEscape(secretAccessKey)},\n  "region": ${jsonEscape(region)}\n}\n`;
  await Bun.write(configPath, payload, {
    mode: 0o600,
  });
}

export function loadCredsFromConfig(): {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
} | null {
  return unwrapOr(
    tryCatchIf(isFileError, () => {
      const raw = readFileSync(getAwsConfigPath(), "utf-8");
      const data = parseJsonWith(raw, AwsCredsSchema);
      if (!data?.accessKeyId || !data?.secretAccessKey) {
        return null;
      }
      if (!/^[A-Za-z0-9/+]{16,128}$/.test(data.accessKeyId)) {
        return null;
      }
      if (data.secretAccessKey.length < 16) {
        return null;
      }
      return {
        accessKeyId: data.accessKeyId,
        secretAccessKey: data.secretAccessKey,
        region: data.region || "us-east-1",
      };
    }),
    null,
  );
}

// ─── Lightsail Bundles ────────────────────────────────────────────────────────

export interface Bundle {
  id: string;
  label: string;
}

export const BUNDLES: Bundle[] = [
  {
    id: "nano_3_0",
    label: "nano \u00b7 2 vCPU \u00b7 512 MB \u00b7 $3.50/mo",
  },
  {
    id: "micro_3_0",
    label: "micro \u00b7 2 vCPU \u00b7 1 GB \u00b7 $5/mo",
  },
  {
    id: "small_3_0",
    label: "small \u00b7 2 vCPU \u00b7 2 GB \u00b7 $10/mo",
  },
  {
    id: "medium_3_0",
    label: "medium \u00b7 2 vCPU \u00b7 4 GB \u00b7 $20/mo",
  },
  {
    id: "large_3_0",
    label: "large \u00b7 2 vCPU \u00b7 8 GB \u00b7 $40/mo",
  },
  {
    id: "xlarge_3_0",
    label: "xlarge \u00b7 2 vCPU \u00b7 16 GB \u00b7 $80/mo",
  },
];

export const DEFAULT_BUNDLE = BUNDLES[0]; // nano_3_0

/** Per-agent default bundles — heavier agents need more RAM. */
const AGENT_BUNDLE_DEFAULTS: Record<string, string> = {
  openclaw: "medium_3_0", // OpenClaw gateway + 713 npm packages needs >=4 GB
};

// ─── Lightsail Regions ────────────────────────────────────────────────────────

interface Region {
  id: string;
  label: string;
}

const REGIONS: Region[] = [
  {
    id: "us-east-1",
    label: "us-east-1 (N. Virginia)",
  },
  {
    id: "us-west-2",
    label: "us-west-2 (Oregon)",
  },
  {
    id: "eu-west-1",
    label: "eu-west-1 (Ireland)",
  },
  {
    id: "eu-central-1",
    label: "eu-central-1 (Frankfurt)",
  },
  {
    id: "ap-southeast-1",
    label: "ap-southeast-1 (Singapore)",
  },
  {
    id: "ap-northeast-1",
    label: "ap-northeast-1 (Tokyo)",
  },
];

// ─── State ──────────────────────────────────────────────────────────────────

interface AwsState {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
  lightsailMode: "cli" | "rest";
  instanceName: string;
  instanceIp: string;
  selectedBundle: string;
}

const _state: AwsState = {
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  region: "us-east-1",
  lightsailMode: "cli",
  instanceName: "",
  instanceIp: "",
  selectedBundle: DEFAULT_BUNDLE.id,
};

export function getState() {
  return {
    awsRegion: _state.region,
    lightsailMode: _state.lightsailMode,
    instanceName: _state.instanceName,
    instanceIp: _state.instanceIp,
  };
}

/** Return SSH connection info for tunnel support. */
export function getConnectionInfo(): {
  host: string;
  user: string;
} {
  return {
    host: _state.instanceIp,
    user: SSH_USER,
  };
}

// ─── SSH Config ─────────────────────────────────────────────────────────────

const SSH_USER = "ubuntu";

// ─── Valibot Schemas for AWS API Responses ──────────────────────────────────

const InstanceStateSchema = v.object({
  instance: v.object({
    state: v.object({
      name: v.string(),
    }),
    publicIpAddress: v.optional(v.string()),
  }),
});

// ─── AWS CLI Wrapper ────────────────────────────────────────────────────────

function awsCliSync(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const proc = Bun.spawnSync(
    [
      "aws",
      ...args,
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
      env: process.env,
    },
  );
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

async function awsCli(args: string[]): Promise<string> {
  const proc = Bun.spawn(
    [
      "aws",
      ...args,
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
      env: process.env,
    },
  );
  // Drain both pipes concurrently before awaiting exit to prevent pipe buffer deadlock
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`aws CLI failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

// ─── SigV4 REST API ─────────────────────────────────────────────────────────

async function lightsailRest(target: string, body = "{}"): Promise<string> {
  if (!_state.accessKeyId || !_state.secretAccessKey) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set for REST API calls");
  }

  const region = _state.region;
  const service = "lightsail";
  const host = `lightsail.${region}.amazonaws.com`;

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const amzDate = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const dateStamp = amzDate.slice(0, 8);

  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
  const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

  const payloadHash = sha256(body);
  const ct = "application/x-amz-json-1.1";

  const allHeaders: [
    string,
    string,
  ][] = [
    [
      "content-type",
      ct,
    ],
    [
      "host",
      host,
    ],
    [
      "x-amz-date",
      amzDate,
    ],
    ...(_state.sessionToken
      ? (() => {
          const tokenHeader: [
            string,
            string,
          ] = [
            "x-amz-security-token",
            _state.sessionToken,
          ];
          return [
            tokenHeader,
          ];
        })()
      : []),
    [
      "x-amz-target",
      target,
    ],
  ];

  const canonicalHeaders = allHeaders.map(([k, v]) => `${k}:${v}`).join("\n") + "\n";
  const signedHeaders = allHeaders.map(([k]) => k).join(";");

  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256(canonicalRequest)}`;

  const kDate = hmac(`AWS4${_state.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const sig = hmac(kSigning, stringToSign).toString("hex");

  const authHeader = `AWS4-HMAC-SHA256 Credential=${_state.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

  const reqHeaders: Record<string, string> = Object.fromEntries(allHeaders.filter(([k]) => k !== "host"));
  reqHeaders["Authorization"] = authHeader;

  const resp = await fetch(`https://${host}/`, {
    method: "POST",
    headers: reqHeaders,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();

  if (!resp.ok) {
    const parsed = tryCatch(() => JSON.parse(text));
    const msg = parsed.ok ? parsed.data.message || parsed.data.Message || parsed.data.__type || "" : "";
    throw new Error(`Lightsail API error (HTTP ${resp.status}) ${target}: ${msg || text}`);
  }

  return text;
}

// ─── AWS CLI Installation ───────────────────────────────────────────────────

function hasAwsCli(): boolean {
  return (
    Bun.spawnSync(
      [
        "which",
        "aws",
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "ignore",
        ],
      },
    ).exitCode === 0
  );
}

async function installAwsCli(): Promise<void> {
  logStep("Installing AWS CLI v2...");

  // Try brew first
  if (
    Bun.spawnSync(
      [
        "which",
        "brew",
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "ignore",
        ],
      },
    ).exitCode === 0
  ) {
    logInfo("Installing via Homebrew...");
    const proc = Bun.spawn(
      [
        "brew",
        "install",
        "awscli",
      ],
      {
        stdio: [
          "ignore",
          "inherit",
          "inherit",
        ],
      },
    );
    if ((await proc.exited) === 0) {
      logInfo("AWS CLI v2 installed via Homebrew");
      return;
    }
    logWarn("Homebrew install failed, falling back to official installer...");
  }

  if (process.platform === "darwin") {
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        'tmp=$(mktemp -d) && curl --proto "=https" -fsSL "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "$tmp/AWSCLIV2.pkg" && sudo installer -pkg "$tmp/AWSCLIV2.pkg" -target / && rm -rf "$tmp"',
      ],
      {
        stdio: [
          "ignore",
          "inherit",
          "inherit",
        ],
      },
    );
    if ((await proc.exited) !== 0) {
      logError("AWS CLI install failed.");
      logError("  Try manually: brew install awscli");
      throw new Error("AWS CLI install failed");
    }
  } else {
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        'tmp=$(mktemp -d) && curl --proto "=https" -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "$tmp/awscliv2.zip" && unzip -q "$tmp/awscliv2.zip" -d "$tmp" && sudo "$tmp/aws/install" && rm -rf "$tmp"',
      ],
      {
        stdio: [
          "ignore",
          "inherit",
          "inherit",
        ],
      },
    );
    if ((await proc.exited) !== 0) {
      logError("AWS CLI install failed.");
      logError("  See: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html");
      throw new Error("AWS CLI install failed");
    }
  }
  logInfo("AWS CLI v2 installed");
}

export async function ensureAwsCli(): Promise<void> {
  if (hasAwsCli()) {
    logInfo("AWS CLI available");
    return;
  }

  logWarn("AWS CLI is not installed.");
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    logInfo("Skipping AWS CLI install (non-interactive mode)");
    return;
  }

  const choice = await prompt("Install AWS CLI now? [Y/n] ");
  if (/^[Nn]/.test(choice)) {
    logInfo("Skipping AWS CLI install.");
    return;
  }

  await installAwsCli();
}

// ─── Authentication ─────────────────────────────────────────────────────────

export async function authenticate(): Promise<void> {
  const region = process.env.AWS_DEFAULT_REGION || process.env.LIGHTSAIL_REGION || "us-east-1";
  if (!validateRegionName(region)) {
    throw new Error(`Invalid AWS region: ${region}. Must match /^[a-zA-Z0-9_-]{1,63}$/`);
  }
  _state.region = region;
  const skipCache = process.env.SPAWN_REAUTH === "1";

  // 1. Try existing CLI with valid credentials
  if (hasAwsCli()) {
    const result = awsCliSync([
      "sts",
      "get-caller-identity",
    ]);
    if (result.exitCode === 0) {
      _state.lightsailMode = "cli";
      process.env.AWS_DEFAULT_REGION = region;
      logInfo(`AWS CLI ready, using region: ${region}`);
      return;
    }
    logWarn("No AWS credentials available in local environment");
  }

  // 2. Check env vars for REST mode
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    _state.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    _state.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    _state.sessionToken = process.env.AWS_SESSION_TOKEN || "";

    if (hasAwsCli()) {
      _state.lightsailMode = "cli";
      process.env.AWS_DEFAULT_REGION = region;
      await saveCredsToConfig(_state.accessKeyId, _state.secretAccessKey, region);
      logInfo(`AWS CLI ready with env credentials, using region: ${region}`);
      return;
    }

    _state.lightsailMode = "rest";
    await saveCredsToConfig(_state.accessKeyId, _state.secretAccessKey, region);
    logInfo("AWS CLI not available \u2014 using Lightsail REST API directly");
    logInfo(`Using region: ${region}`);
    return;
  }

  // 3. Try cached credentials from ~/.config/spawn/aws.json
  if (!skipCache) {
    const cached = loadCredsFromConfig();
    if (cached) {
      const cachedRegion = process.env.AWS_DEFAULT_REGION || process.env.LIGHTSAIL_REGION || cached.region;
      if (!validateRegionName(cachedRegion)) {
        throw new Error(`Invalid AWS region: ${cachedRegion}. Must match /^[a-zA-Z0-9_-]{1,63}$/`);
      }
      process.env.AWS_ACCESS_KEY_ID = cached.accessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = cached.secretAccessKey;
      process.env.AWS_DEFAULT_REGION = cachedRegion;
      _state.region = cachedRegion;
      _state.accessKeyId = cached.accessKeyId;
      _state.secretAccessKey = cached.secretAccessKey;

      if (hasAwsCli()) {
        const result = awsCliSync([
          "sts",
          "get-caller-identity",
        ]);
        if (result.exitCode === 0) {
          _state.lightsailMode = "cli";
          logInfo(`AWS CLI ready with credentials cached by spawn. Using region: ${cachedRegion}`);
          return;
        }
        logWarn("Credentials cached by spawn are invalid or expired");
        _state.accessKeyId = "";
        _state.secretAccessKey = "";
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        _state.lightsailMode = "rest";
        logInfo("Using cached AWS credentials with Lightsail REST API");
        logInfo(`Using region: ${cachedRegion}`);
        return;
      }
    }
  }

  // 4. Interactive credential entry
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    logError("AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
    throw new Error("No AWS credentials");
  }

  if (skipCache) {
    logStep("Re-entering AWS credentials (--reauth):");
  } else {
    logStep("Enter your AWS credentials:");
  }
  const accessKey = await prompt("AWS Access Key ID: ");
  if (!accessKey) {
    throw new Error("No access key provided");
  }
  const secretKey = await prompt("AWS Secret Access Key: ");
  if (!secretKey) {
    throw new Error("No secret key provided");
  }

  process.env.AWS_ACCESS_KEY_ID = accessKey;
  process.env.AWS_SECRET_ACCESS_KEY = secretKey;
  process.env.AWS_DEFAULT_REGION = region;
  _state.accessKeyId = accessKey;
  _state.secretAccessKey = secretKey;

  if (hasAwsCli()) {
    const result = awsCliSync([
      "sts",
      "get-caller-identity",
    ]);
    if (result.exitCode === 0) {
      _state.lightsailMode = "cli";
      await saveCredsToConfig(accessKey, secretKey, region);
      logInfo(`AWS CLI configured, using region: ${region}`);
      return;
    }
  }

  _state.lightsailMode = "rest";
  await saveCredsToConfig(accessKey, secretKey, region);
  logInfo("Using Lightsail REST API directly");
  logInfo(`Using region: ${region}`);
}

// ─── Region Prompt ──────────────────────────────────────────────────────────

export async function promptRegion(): Promise<void> {
  if (process.env.AWS_DEFAULT_REGION || process.env.LIGHTSAIL_REGION) {
    const envRegion = process.env.AWS_DEFAULT_REGION || process.env.LIGHTSAIL_REGION || "us-east-1";
    if (!validateRegionName(envRegion)) {
      throw new Error(`Invalid AWS region: ${envRegion}. Must match /^[a-zA-Z0-9_-]{1,63}$/`);
    }
    _state.region = envRegion;
    return;
  }
  if (process.env.SPAWN_CUSTOM !== "1") {
    return;
  }
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return;
  }

  process.stderr.write("\n");
  const items = REGIONS.map((r) => `${r.id}|${r.label}`);
  const selected = await selectFromList(items, "AWS region", "us-east-1");
  _state.region = selected;
  process.env.AWS_DEFAULT_REGION = selected;
  logInfo(`Using region: ${selected}`);
}

// ─── Bundle Prompt ──────────────────────────────────────────────────────────

export async function promptBundle(agentName?: string): Promise<void> {
  if (process.env.LIGHTSAIL_BUNDLE) {
    _state.selectedBundle = process.env.LIGHTSAIL_BUNDLE;
    return;
  }

  // Use per-agent default if available (e.g. openclaw → medium)
  const agentDefault = agentName ? AGENT_BUNDLE_DEFAULTS[agentName] : undefined;
  const defaultId = agentDefault ?? DEFAULT_BUNDLE.id;

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    _state.selectedBundle = defaultId;
    return;
  }

  process.stderr.write("\n");
  const items = BUNDLES.map((b) => `${b.id}|${b.label}`);
  const selected = await selectFromList(items, "instance size", defaultId);
  _state.selectedBundle = selected;
  logInfo(`Using bundle: ${selected}`);
}

// ─── Lightsail Operation Helpers ─────────────────────────────────────────────
// These helpers abstract the CLI-vs-REST branching so each consumer is a single
// linear flow instead of duplicating the branch in every function.

/** Check if a Lightsail key pair exists. Returns true if found, false otherwise. */
async function lightsailGetKeyPair(keyPairName: string): Promise<boolean> {
  if (_state.lightsailMode === "cli") {
    return (
      awsCliSync([
        "lightsail",
        "get-key-pair",
        "--key-pair-name",
        keyPairName,
      ]).exitCode === 0
    );
  }
  const r = await asyncTryCatch(() =>
    lightsailRest(
      "Lightsail_20161128.GetKeyPair",
      JSON.stringify({
        keyPairName,
      }),
    ),
  );
  return r.ok;
}

/** Import a public key to Lightsail as a key pair. */
async function lightsailImportKeyPair(keyPairName: string, publicKeyBase64: string): Promise<void> {
  if (_state.lightsailMode === "cli") {
    await awsCli([
      "lightsail",
      "import-key-pair",
      "--key-pair-name",
      keyPairName,
      "--public-key-base64",
      publicKeyBase64,
    ]);
    return;
  }
  await lightsailRest(
    "Lightsail_20161128.ImportKeyPair",
    JSON.stringify({
      keyPairName,
      publicKeyBase64,
    }),
  );
}

/** Create Lightsail instances. */
async function lightsailCreateInstances(params: {
  name: string;
  az: string;
  blueprint: string;
  bundle: string;
  keyPairName: string;
  userData: string;
}): Promise<void> {
  if (_state.lightsailMode === "cli") {
    await awsCli([
      "lightsail",
      "create-instances",
      "--instance-names",
      params.name,
      "--availability-zone",
      params.az,
      "--blueprint-id",
      params.blueprint,
      "--bundle-id",
      params.bundle,
      "--key-pair-name",
      params.keyPairName,
      "--user-data",
      params.userData,
    ]);
    return;
  }
  await lightsailRest(
    "Lightsail_20161128.CreateInstances",
    JSON.stringify({
      instanceNames: [
        params.name,
      ],
      availabilityZone: params.az,
      blueprintId: params.blueprint,
      bundleId: params.bundle,
      keyPairName: params.keyPairName,
      userData: params.userData,
    }),
  );
}

/** Get Lightsail instance state and public IP. */
async function lightsailGetInstance(instanceName: string): Promise<{
  state: string;
  ip: string;
}> {
  if (_state.lightsailMode === "cli") {
    const resp = await awsCli([
      "lightsail",
      "get-instance",
      "--instance-name",
      instanceName,
      "--output",
      "json",
    ]);
    const data = parseJsonWith(resp, InstanceStateSchema);
    return {
      state: data?.instance?.state?.name || "",
      ip: data?.instance?.publicIpAddress || "",
    };
  }
  const resp = await lightsailRest(
    "Lightsail_20161128.GetInstance",
    JSON.stringify({
      instanceName,
    }),
  );
  const data = parseJsonWith(resp, InstanceStateSchema);
  return {
    state: data?.instance?.state?.name || "",
    ip: data?.instance?.publicIpAddress || "",
  };
}

// ─── SSH Key Management ─────────────────────────────────────────────────────

export async function ensureSshKey(): Promise<void> {
  const selectedKeys = await ensureSshKeys();
  // Lightsail associates one key pair per instance — use the first selected key
  const key = selectedKeys[0];

  const pubPath = key.pubPath;
  if (!existsSync(pubPath)) {
    throw new Error(`SSH public key not found: ${pubPath}`);
  }

  const keyName = "spawn-key";
  const pubKey = readFileSync(pubPath, "utf-8").trim();

  if (await lightsailGetKeyPair(keyName)) {
    logInfo("SSH key already registered with Lightsail");
    return;
  }

  logStep("Importing SSH key to Lightsail...");
  const importResult = await asyncTryCatch(() => lightsailImportKeyPair(keyName, pubKey));
  if (!importResult.ok) {
    // Race condition: another process may have imported it
    if (await lightsailGetKeyPair(keyName)) {
      logInfo("SSH key already registered with Lightsail");
      return;
    }
    throw new Error(
      "Failed to import SSH key to Lightsail. " +
        "On new AWS accounts, Lightsail may not be enabled. " +
        "Visit https://lightsail.aws.amazon.com/ to activate it, then try again.",
    );
  }
  logInfo("SSH key imported to Lightsail");
}

// ─── Cloud-init User Data ───────────────────────────────────────────────────

function getCloudInitUserdata(tier: CloudInitTier = "full"): string {
  const packages = getPackagesForTier(tier);
  const lines = [
    "#!/bin/bash",
    "export DEBIAN_FRONTEND=noninteractive",
    "# Set up swap early — nano instances (512 MB) OOM during large installs",
    "if ! swapon --show 2>/dev/null | grep -q /swapfile; then",
    "  fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none",
    "  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile",
    "fi",
    "apt-get update -y",
    `apt-get install -y --no-install-recommends ${packages.join(" ")}`,
  ];
  if (needsNode(tier)) {
    lines.push(
      "# Install Node.js 22 via n (run as root so it installs to /usr/local/bin/)",
      `${NODE_INSTALL_CMD} || true`,
      "# Install Claude Code",
      "su - ubuntu -c 'curl --proto \"=https\" -fsSL https://claude.ai/install.sh | bash'",
    );
  }
  if (needsBun(tier)) {
    lines.push(
      "# Install Bun",
      "su - ubuntu -c 'curl --proto \"=https\" -fsSL https://bun.sh/install | bash'",
      "ln -sf /home/ubuntu/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || true",
    );
  }
  lines.push(
    "# Configure PATH",
    "echo 'export PATH=\"${HOME}/.npm-global/bin:${HOME}/.claude/local/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}\"' >> /home/ubuntu/.bashrc",
    "echo 'export PATH=\"${HOME}/.npm-global/bin:${HOME}/.claude/local/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}\"' >> /home/ubuntu/.zshrc",
    "chown ubuntu:ubuntu /home/ubuntu/.bashrc /home/ubuntu/.zshrc",
    "touch /home/ubuntu/.cloud-init-complete",
    "chown ubuntu:ubuntu /home/ubuntu/.cloud-init-complete",
  );
  return lines.join("\n") + "\n";
}

// ─── Provisioning ───────────────────────────────────────────────────────────

export async function createInstance(name: string, tier?: CloudInitTier): Promise<VMConnection> {
  const bundle = _state.selectedBundle;
  const region = _state.region;
  const az = `${region}a`;
  const blueprint = "ubuntu_24_04";

  if (!validateRegionName(region)) {
    throw new Error("Invalid AWS region");
  }

  logStep(`Creating Lightsail instance '${name}' (bundle: ${bundle}, AZ: ${az})...`);

  const userdata = getCloudInitUserdata(tier);
  const createParams = {
    name,
    az,
    blueprint,
    bundle,
    keyPairName: "spawn-key",
    userData: userdata,
  };

  try {
    await lightsailCreateInstances(createParams);
  } catch (err) {
    const errMsg = getErrorMessage(err);
    logError(`Failed to create Lightsail instance: ${errMsg}`);

    if (isBillingError("aws", errMsg)) {
      const shouldRetry = await handleBillingError("aws");
      if (shouldRetry) {
        logStep("Retrying instance creation...");
        await lightsailCreateInstances(createParams);
        _state.instanceName = name;
        logInfo(`Instance creation initiated: ${name}`);
        return await waitForInstance();
      }
    } else {
      showNonBillingError("aws", [
        "Lightsail not enabled: visit https://lightsail.aws.amazon.com/ls/webapp/home to activate",
        "Instance limit reached for your account",
        "Bundle unavailable in region",
        "AWS credentials lack Lightsail permissions",
        `Instance name '${name}' already in use`,
      ]);
    }
    throw err;
  }

  _state.instanceName = name;
  logInfo(`Instance creation initiated: ${name}`);

  // Wait for instance to become running and get IP
  return await waitForInstance();
}

// ─── Wait for Instance ──────────────────────────────────────────────────────

async function waitForInstance(maxAttempts = 60): Promise<VMConnection> {
  logStep("Waiting for instance to become running...");
  const pollDelay = 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const infoResult = await asyncTryCatch(() => lightsailGetInstance(_state.instanceName));
    const state = infoResult.ok ? infoResult.data.state : "";
    const ip = infoResult.ok ? infoResult.data.ip : "";

    if (state === "running") {
      _state.instanceIp = ip.trim();
      logStepDone();
      logInfo(`Instance running: IP=${_state.instanceIp}`);

      return {
        ip: _state.instanceIp,
        user: SSH_USER,
        server_name: _state.instanceName,
        cloud: "aws",
      };
    }

    logStepInline(`Instance state: ${state || "pending"} (${attempt}/${maxAttempts})`);
    await sleep(pollDelay);
  }

  logStepDone();
  logError(`Instance did not become running after ${maxAttempts} checks`);
  throw new Error("Instance start timeout");
}

// ─── SSH Execution ──────────────────────────────────────────────────────────

async function waitForSsh(maxAttempts = 36): Promise<void> {
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  await sharedWaitForSsh({
    host: _state.instanceIp,
    user: SSH_USER,
    maxAttempts,
    extraSshOpts: keyOpts,
  });
}

export async function waitForCloudInit(maxAttempts = 60): Promise<void> {
  await waitForSsh();
  const keyOpts = getSshKeyOpts(await ensureSshKeys());

  logStep("Waiting for cloud-init to complete...");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const proc = Bun.spawn(
        [
          "ssh",
          ...SSH_BASE_OPTS,
          ...keyOpts,
          `${SSH_USER}@${_state.instanceIp}`,
          "test -f /home/ubuntu/.cloud-init-complete && echo done",
        ],
        {
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        },
      );
      // Per-process timeout: if the network drops during cloud-init polling,
      // `await proc.exited` blocks forever. Kill after 30s so the retry loop
      // can continue and the user isn't left with a hung CLI.
      const timer = setTimeout(() => killWithTimeout(proc), 30_000);
      // Drain both pipes before awaiting exit to prevent pipe buffer deadlock
      let stdout: string;
      let exitCode: number;
      try {
        [stdout] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        exitCode = await proc.exited;
      } finally {
        clearTimeout(timer);
      }
      if (exitCode === 0 && stdout.includes("done")) {
        logStepDone();
        logInfo("Cloud-init complete");
        return;
      }
    } catch {
      // ignore
    }
    logStepInline(`Cloud-init still running (${attempt}/${maxAttempts})`);
    await sleep(5000);
  }

  logStepDone();
  logWarn("Cloud-init did not complete in time, continuing anyway...");
}

export async function runServer(cmd: string, timeoutSecs?: number): Promise<void> {
  const fullCmd = `export PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  const proc = Bun.spawn(
    [
      "ssh",
      ...SSH_BASE_OPTS,
      ...keyOpts,
      `${SSH_USER}@${_state.instanceIp}`,
      `bash -c '${fullCmd.replace(/'/g, "'\\''")}'`,
    ],
    {
      stdio: [
        "ignore",
        "inherit",
        "inherit",
      ],
    },
  );
  const timeout = (timeoutSecs || 300) * 1000;
  const timer = setTimeout(() => killWithTimeout(proc), timeout);
  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`run_server failed (exit ${exitCode}): ${cmd}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadFile(localPath: string, remotePath: string): Promise<void> {
  if (
    !/^[a-zA-Z0-9/_.~-]+$/.test(remotePath) ||
    remotePath.includes("..") ||
    remotePath.split("/").some((s) => s.startsWith("-"))
  ) {
    throw new Error(`Invalid remote path: ${remotePath}`);
  }
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  const proc = Bun.spawn(
    [
      "scp",
      ...SSH_BASE_OPTS,
      ...keyOpts,
      localPath,
      `${SSH_USER}@${_state.instanceIp}:${remotePath}`,
    ],
    {
      stdio: [
        "ignore",
        "inherit",
        "inherit",
      ],
    },
  );
  const timer = setTimeout(() => killWithTimeout(proc), 120_000);
  try {
    if ((await proc.exited) !== 0) {
      throw new Error(`upload_file failed for ${remotePath}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function interactiveSession(cmd: string): Promise<number> {
  const term = sanitizeTermValue(process.env.TERM || "xterm-256color");
  // Single-quote escaping prevents premature shell expansion of $variables in cmd
  const shellEscapedCmd = cmd.replace(/'/g, "'\\''");
  // Pass command directly to SSH (no outer bash -c wrapper) — matches Hetzner/DO behavior.
  // The extra bash -c layer added latency and an unnecessary shell process.
  const fullCmd = `export TERM=${term} PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && exec bash -l -c '${shellEscapedCmd}'`;
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  const exitCode = spawnInteractive([
    "ssh",
    ...SSH_INTERACTIVE_OPTS,
    ...keyOpts,
    `${SSH_USER}@${_state.instanceIp}`,
    fullCmd,
  ]);

  // Post-session summary
  process.stderr.write("\n");
  logWarn(`Session ended. Your Lightsail instance '${_state.instanceName}' is still running.`);
  logWarn("Remember to delete it when you're done to avoid ongoing charges.");
  logWarn("");
  logWarn("Manage or delete it in your dashboard:");
  logWarn(`  ${DASHBOARD_URL}`);
  logWarn("");
  logInfo("To delete from CLI:");
  logInfo("  spawn delete");
  logInfo("To reconnect:");
  logInfo(`  ssh ${SSH_USER}@${_state.instanceIp}`);

  return exitCode;
}

// ─── Server Name ────────────────────────────────────────────────────────────

export async function getServerName(): Promise<string> {
  return getServerNameFromEnv("LIGHTSAIL_SERVER_NAME");
}

export async function promptSpawnName(): Promise<void> {
  return promptSpawnNameShared("AWS instance");
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export async function destroyServer(name?: string): Promise<void> {
  const target = name || _state.instanceName;
  if (!target) {
    throw new Error("destroy_server: no instance name provided");
  }

  logStep(`Destroying Lightsail instance '${target}'...`);

  const deleteResult =
    _state.lightsailMode === "cli"
      ? await asyncTryCatch(() =>
          awsCli([
            "lightsail",
            "delete-instance",
            "--instance-name",
            target,
          ]),
        )
      : await asyncTryCatch(() =>
          lightsailRest(
            "Lightsail_20161128.DeleteInstance",
            JSON.stringify({
              instanceName: target,
              forceDeleteAddOns: false,
            }),
          ),
        );
  if (!deleteResult.ok) {
    logError(`Failed to destroy Lightsail instance '${target}'`);
    logWarn(`Delete it manually: ${DASHBOARD_URL}`);
    throw new Error("Instance deletion failed");
  }
  logInfo(`Instance '${target}' destroyed`);
}
