// aws/aws.ts — Core AWS Lightsail provider: auth, provisioning, SSH execution

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  logInfo,
  logWarn,
  logError,
  logStep,
  prompt,
  selectFromList,
  validateServerName,
  validateRegionName,
  toKebabCase,
  defaultSpawnName,
  sanitizeTermValue,
  jsonEscape,
} from "../shared/ui";
import type { CloudInitTier } from "../shared/agents";
import { getPackagesForTier, needsNode, needsBun, NODE_INSTALL_CMD } from "../shared/cloud-init";
import { SSH_BASE_OPTS, SSH_INTERACTIVE_OPTS, sleep, waitForSsh as sharedWaitForSsh } from "../shared/ssh";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys";
import * as v from "valibot";
import { parseJsonWith } from "../shared/parse";
import { saveVmConnection } from "../history.js";

const DASHBOARD_URL = "https://lightsail.aws.amazon.com/";

// ─── Credential Cache ────────────────────────────────────────────────────────

export const AWS_CONFIG_PATH = `${process.env.HOME}/.config/spawn/aws.json`;

const AwsCredsSchema = v.object({
  accessKeyId: v.string(),
  secretAccessKey: v.string(),
  region: v.optional(v.string()),
});

export async function saveCredsToConfig(accessKeyId: string, secretAccessKey: string, region: string): Promise<void> {
  const dir = AWS_CONFIG_PATH.replace(/\/[^/]+$/, "");
  await Bun.spawn(["mkdir", "-p", dir]).exited;
  const payload = `{\n  "accessKeyId": ${jsonEscape(accessKeyId)},\n  "secretAccessKey": ${jsonEscape(secretAccessKey)},\n  "region": ${jsonEscape(region)}\n}\n`;
  await Bun.write(AWS_CONFIG_PATH, payload, { mode: 0o600 });
}

export function loadCredsFromConfig(): { accessKeyId: string; secretAccessKey: string; region: string } | null {
  try {
    const raw = readFileSync(AWS_CONFIG_PATH, "utf-8");
    const data = parseJsonWith(raw, AwsCredsSchema);
    if (!data?.accessKeyId || !data?.secretAccessKey) { return null; }
    if (!/^[A-Za-z0-9/+]{16,128}$/.test(data.accessKeyId)) { return null; }
    if (data.secretAccessKey.length < 16) { return null; }
    return {
      accessKeyId: data.accessKeyId,
      secretAccessKey: data.secretAccessKey,
      region: data.region || "us-east-1",
    };
  } catch {
    return null;
  }
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

// ─── Lightsail Regions ────────────────────────────────────────────────────────

export interface Region {
  id: string;
  label: string;
}

export const REGIONS: Region[] = [
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

let awsAccessKeyId = "";
let awsSecretAccessKey = "";
let awsSessionToken = "";
let awsRegion = "us-east-1";
let lightsailMode: "cli" | "rest" = "cli";
let instanceName = "";
let instanceIp = "";

export function getState() {
  return {
    awsRegion,
    lightsailMode,
    instanceName,
    instanceIp,
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

const InstanceListSchema = v.object({
  instances: v.optional(
    v.array(
      v.object({
        name: v.optional(v.string()),
        state: v.optional(
          v.object({
            name: v.optional(v.string()),
          }),
        ),
        publicIpAddress: v.optional(v.string()),
        bundleId: v.optional(v.string()),
      }),
    ),
  ),
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
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`aws CLI failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

// ─── SigV4 REST API ─────────────────────────────────────────────────────────

async function lightsailRest(target: string, body = "{}"): Promise<string> {
  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set for REST API calls");
  }

  const region = awsRegion;
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
    ...(awsSessionToken
      ? (() => {
          const tokenHeader: [
            string,
            string,
          ] = [
            "x-amz-security-token",
            awsSessionToken,
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

  const kDate = hmac(`AWS4${awsSecretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const sig = hmac(kSigning, stringToSign).toString("hex");

  const authHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

  const reqHeaders: Record<string, string> = Object.fromEntries(allHeaders.filter(([k]) => k !== "host"));
  reqHeaders["Authorization"] = authHeader;

  const resp = await fetch(`https://${host}/`, {
    method: "POST",
    headers: reqHeaders,
    body,
  });
  const text = await resp.text();

  if (!resp.ok) {
    let msg = "";
    try {
      const e = JSON.parse(text);
      msg = e.message || e.Message || e.__type || "";
    } catch {
      /* ignore */
    }
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
        'tmp=$(mktemp -d) && curl -fsSL "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "$tmp/AWSCLIV2.pkg" && sudo installer -pkg "$tmp/AWSCLIV2.pkg" -target / && rm -rf "$tmp"',
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
        'tmp=$(mktemp -d) && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "$tmp/awscliv2.zip" && unzip -q "$tmp/awscliv2.zip" -d "$tmp" && sudo "$tmp/aws/install" && rm -rf "$tmp"',
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
  awsRegion = region;
  const skipCache = process.env.SPAWN_REAUTH === "1";

  // 1. Try existing CLI with valid credentials
  if (hasAwsCli()) {
    const result = awsCliSync([
      "sts",
      "get-caller-identity",
    ]);
    if (result.exitCode === 0) {
      lightsailMode = "cli";
      process.env.AWS_DEFAULT_REGION = region;
      logInfo(`AWS CLI ready, using region: ${region}`);
      return;
    }
    logWarn("AWS CLI found but credentials invalid or expired");
  }

  // 2. Check env vars for REST mode
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
    awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    awsSessionToken = process.env.AWS_SESSION_TOKEN || "";

    if (hasAwsCli()) {
      lightsailMode = "cli";
      process.env.AWS_DEFAULT_REGION = region;
      await saveCredsToConfig(awsAccessKeyId, awsSecretAccessKey, region);
      logInfo(`AWS CLI ready with env credentials, using region: ${region}`);
      return;
    }

    lightsailMode = "rest";
    await saveCredsToConfig(awsAccessKeyId, awsSecretAccessKey, region);
    logInfo("AWS CLI not available \u2014 using Lightsail REST API directly");
    logInfo(`Using region: ${region}`);
    return;
  }

  // 3. Try cached credentials from ~/.config/spawn/aws.json
  if (!skipCache) {
    const cached = loadCredsFromConfig();
    if (cached) {
      const cachedRegion = process.env.AWS_DEFAULT_REGION || process.env.LIGHTSAIL_REGION || cached.region;
      process.env.AWS_ACCESS_KEY_ID = cached.accessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = cached.secretAccessKey;
      process.env.AWS_DEFAULT_REGION = cachedRegion;
      awsRegion = cachedRegion;
      awsAccessKeyId = cached.accessKeyId;
      awsSecretAccessKey = cached.secretAccessKey;

      if (hasAwsCli()) {
        const result = awsCliSync(["sts", "get-caller-identity"]);
        if (result.exitCode === 0) {
          lightsailMode = "cli";
          logInfo(`AWS CLI ready with cached credentials, using region: ${cachedRegion}`);
          return;
        }
        logWarn("Cached AWS credentials invalid or expired");
        awsAccessKeyId = "";
        awsSecretAccessKey = "";
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        lightsailMode = "rest";
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
  awsAccessKeyId = accessKey;
  awsSecretAccessKey = secretKey;

  if (hasAwsCli()) {
    const result = awsCliSync([
      "sts",
      "get-caller-identity",
    ]);
    if (result.exitCode === 0) {
      lightsailMode = "cli";
      await saveCredsToConfig(accessKey, secretKey, region);
      logInfo(`AWS CLI configured, using region: ${region}`);
      return;
    }
  }

  lightsailMode = "rest";
  await saveCredsToConfig(accessKey, secretKey, region);
  logInfo("Using Lightsail REST API directly");
  logInfo(`Using region: ${region}`);
}

// ─── Region Prompt ──────────────────────────────────────────────────────────

export async function promptRegion(): Promise<void> {
  if (process.env.AWS_DEFAULT_REGION || process.env.LIGHTSAIL_REGION) {
    awsRegion = process.env.AWS_DEFAULT_REGION || process.env.LIGHTSAIL_REGION || "us-east-1";
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
  awsRegion = selected;
  process.env.AWS_DEFAULT_REGION = selected;
  logInfo(`Using region: ${selected}`);
}

// ─── Bundle Prompt ──────────────────────────────────────────────────────────

let selectedBundle = DEFAULT_BUNDLE.id;

export async function promptBundle(): Promise<void> {
  if (process.env.LIGHTSAIL_BUNDLE) {
    selectedBundle = process.env.LIGHTSAIL_BUNDLE;
    return;
  }
  if (process.env.SPAWN_CUSTOM !== "1") {
    return;
  }
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return;
  }

  process.stderr.write("\n");
  const items = BUNDLES.map((b) => `${b.id}|${b.label}`);
  const selected = await selectFromList(items, "instance size", DEFAULT_BUNDLE.id);
  selectedBundle = selected;
  logInfo(`Using bundle: ${selected}`);
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

  if (lightsailMode === "cli") {
    // Check if already registered
    const check = awsCliSync([
      "lightsail",
      "get-key-pair",
      "--key-pair-name",
      keyName,
    ]);
    if (check.exitCode === 0) {
      logInfo("SSH key already registered with Lightsail");
      return;
    }

    logStep("Importing SSH key to Lightsail...");
    try {
      await awsCli([
        "lightsail",
        "import-key-pair",
        "--key-pair-name",
        keyName,
        "--public-key-base64",
        pubKey,
      ]);
    } catch {
      // Race condition: another process may have imported it
      const recheck = awsCliSync([
        "lightsail",
        "get-key-pair",
        "--key-pair-name",
        keyName,
      ]);
      if (recheck.exitCode === 0) {
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
  } else {
    // REST path
    try {
      await lightsailRest(
        "Lightsail_20161128.GetKeyPair",
        JSON.stringify({
          keyPairName: keyName,
        }),
      );
      logInfo("SSH key already registered with Lightsail");
      return;
    } catch {
      // Key doesn't exist, import it
    }

    logStep("Importing SSH key to Lightsail via REST API...");
    try {
      await lightsailRest(
        "Lightsail_20161128.ImportKeyPair",
        JSON.stringify({
          keyPairName: keyName,
          publicKeyBase64: pubKey,
        }),
      );
    } catch {
      // Race condition check
      try {
        await lightsailRest(
          "Lightsail_20161128.GetKeyPair",
          JSON.stringify({
            keyPairName: keyName,
          }),
        );
        logInfo("SSH key already registered with Lightsail");
        return;
      } catch {
        throw new Error(
          "Failed to import SSH key to Lightsail. " +
            "On new AWS accounts, Lightsail may not be enabled. " +
            "Visit https://lightsail.aws.amazon.com/ to activate it, then try again.",
        );
      }
    }
    logInfo("SSH key imported to Lightsail");
  }
}

// ─── Cloud-init User Data ───────────────────────────────────────────────────

function getCloudInitUserdata(tier: CloudInitTier = "full"): string {
  const packages = getPackagesForTier(tier);
  const lines = [
    "#!/bin/bash",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -y",
    `apt-get install -y --no-install-recommends ${packages.join(" ")}`,
  ];
  if (needsNode(tier)) {
    lines.push(
      "# Install Node.js 22 via n",
      `su - ubuntu -c '${NODE_INSTALL_CMD}'`,
      "# Install Claude Code",
      "su - ubuntu -c 'curl -fsSL https://claude.ai/install.sh | bash'",
      "# Configure npm global prefix",
      "su - ubuntu -c 'mkdir -p ~/.npm-global/bin && npm config set prefix ~/.npm-global'",
    );
  }
  if (needsBun(tier)) {
    lines.push(
      "# Install Bun",
      "su - ubuntu -c 'curl -fsSL https://bun.sh/install | bash'",
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

export async function createInstance(name: string, tier?: CloudInitTier): Promise<void> {
  const bundle = selectedBundle;
  const region = awsRegion;
  const az = `${region}a`;
  const blueprint = "ubuntu_24_04";

  if (!validateRegionName(region)) {
    throw new Error("Invalid AWS region");
  }

  logStep(`Creating Lightsail instance '${name}' (bundle: ${bundle}, AZ: ${az})...`);

  const userdata = getCloudInitUserdata(tier);

  if (lightsailMode === "cli") {
    try {
      await awsCli([
        "lightsail",
        "create-instances",
        "--instance-names",
        name,
        "--availability-zone",
        az,
        "--blueprint-id",
        blueprint,
        "--bundle-id",
        bundle,
        "--key-pair-name",
        "spawn-key",
        "--user-data",
        userdata,
      ]);
    } catch (err) {
      logError("Failed to create Lightsail instance");
      logWarn("Common issues:");
      logWarn("  - Instance limit reached for your account");
      logWarn("  - Bundle unavailable in region");
      logWarn("  - AWS credentials lack Lightsail permissions");
      logWarn(`  - Instance name '${name}' already in use`);
      throw err;
    }
  } else {
    try {
      await lightsailRest(
        "Lightsail_20161128.CreateInstances",
        JSON.stringify({
          instanceNames: [
            name,
          ],
          availabilityZone: az,
          blueprintId: blueprint,
          bundleId: bundle,
          keyPairName: "spawn-key",
          userData: userdata,
        }),
      );
    } catch (err) {
      logError("Failed to create Lightsail instance");
      logWarn("Common issues:");
      logWarn("  - Instance limit reached for your account");
      logWarn("  - Bundle unavailable in region");
      logWarn("  - Credentials lack lightsail:CreateInstances permission");
      logWarn(`  - Instance name '${name}' already in use`);
      throw err;
    }
  }

  instanceName = name;
  logInfo(`Instance creation initiated: ${name}`);
}

// ─── Wait for Instance ──────────────────────────────────────────────────────

export async function waitForInstance(maxAttempts = 60): Promise<void> {
  logStep("Waiting for instance to become running...");
  const pollDelay = 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let state = "";
    let ip = "";

    try {
      if (lightsailMode === "cli") {
        const resp = await awsCli([
          "lightsail",
          "get-instance",
          "--instance-name",
          instanceName,
          "--query",
          "instance.state.name",
          "--output",
          "text",
        ]);
        state = resp.trim();
      } else {
        const resp = await lightsailRest(
          "Lightsail_20161128.GetInstance",
          JSON.stringify({
            instanceName,
          }),
        );
        const data = parseJsonWith(resp, InstanceStateSchema);
        state = data?.instance?.state?.name || "";
      }
    } catch {
      state = "";
    }

    if (state === "running") {
      try {
        if (lightsailMode === "cli") {
          ip = await awsCli([
            "lightsail",
            "get-instance",
            "--instance-name",
            instanceName,
            "--query",
            "instance.publicIpAddress",
            "--output",
            "text",
          ]);
        } else {
          const resp = await lightsailRest(
            "Lightsail_20161128.GetInstance",
            JSON.stringify({
              instanceName,
            }),
          );
          const data = parseJsonWith(resp, InstanceStateSchema);
          ip = data?.instance?.publicIpAddress || "";
        }
      } catch {
        // ignore
      }

      instanceIp = ip.trim();
      logInfo(`Instance running: IP=${instanceIp}`);

      // Save connection info
      saveVmConnection(instanceIp, SSH_USER, "", instanceName, "aws");
      return;
    }

    logStep(`Instance state: ${state || "pending"} (${attempt}/${maxAttempts})`);
    await sleep(pollDelay);
  }

  logError(`Instance did not become running after ${maxAttempts} checks`);
  throw new Error("Instance start timeout");
}

// ─── SSH Execution ──────────────────────────────────────────────────────────

export async function waitForSsh(maxAttempts = 36): Promise<void> {
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  await sharedWaitForSsh({
    host: instanceIp,
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
          `${SSH_USER}@${instanceIp}`,
          "test -f /home/ubuntu/.cloud-init-complete",
        ],
        {
          stdio: [
            "ignore",
            "pipe",
            "ignore",
          ],
        },
      );
      if ((await proc.exited) === 0) {
        logInfo("Cloud-init complete");
        return;
      }
    } catch {
      // ignore
    }
    logStep(`Cloud-init still running (${attempt}/${maxAttempts})`);
    await sleep(5000);
  }

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
      `${SSH_USER}@${instanceIp}`,
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
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeout);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (exitCode !== 0) {
    throw new Error(`run_server failed (exit ${exitCode}): ${cmd}`);
  }
}

export async function runServerCapture(cmd: string, timeoutSecs?: number): Promise<string> {
  const fullCmd = `export PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  const proc = Bun.spawn(
    [
      "ssh",
      ...SSH_BASE_OPTS,
      ...keyOpts,
      `${SSH_USER}@${instanceIp}`,
      `bash -c '${fullCmd.replace(/'/g, "'\\''")}'`,
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );
  const timeout = (timeoutSecs || 300) * 1000;
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeout);
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (exitCode !== 0) {
    throw new Error(`run_server_capture failed (exit ${exitCode})`);
  }
  return stdout.trim();
}

export async function uploadFile(localPath: string, remotePath: string): Promise<void> {
  if (!/^[a-zA-Z0-9/_.~-]+$/.test(remotePath)) {
    throw new Error(`Invalid remote path: ${remotePath}`);
  }
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  const proc = Bun.spawn(
    [
      "scp",
      ...SSH_BASE_OPTS,
      ...keyOpts,
      localPath,
      `${SSH_USER}@${instanceIp}:${remotePath}`,
    ],
    {
      stdio: [
        "ignore",
        "ignore",
        "pipe",
      ],
    },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`upload_file failed for ${remotePath}`);
  }
}

export async function interactiveSession(cmd: string): Promise<number> {
  const term = sanitizeTermValue(process.env.TERM || "xterm-256color");
  const fullCmd = `export TERM=${term} PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && exec bash -l -c ${JSON.stringify(cmd)}`;
  const escapedCmd = fullCmd.replace(/'/g, "'\\''");
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        ...SSH_INTERACTIVE_OPTS,
        ...keyOpts,
        `${SSH_USER}@${instanceIp}`,
        `bash -c '${escapedCmd}'`,
      ],
      {
        stdio: "inherit",
      },
    );
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", reject);
  });

  // Post-session summary
  process.stderr.write("\n");
  logWarn(`Session ended. Your Lightsail instance '${instanceName}' is still running.`);
  logWarn("Remember to delete it when you're done to avoid ongoing charges.");
  logWarn("");
  logWarn("Manage or delete it in your dashboard:");
  logWarn(`  ${DASHBOARD_URL}`);
  logWarn("");
  logInfo("To delete from CLI:");
  logInfo("  spawn delete");
  logInfo("To reconnect:");
  logInfo(`  ssh ${SSH_USER}@${instanceIp}`);

  return exitCode;
}

// ─── Retry + Wait Helpers ───────────────────────────────────────────────────

export async function runWithRetry(
  maxAttempts: number,
  sleepSec: number,
  timeoutSecs: number,
  cmd: string,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runServer(cmd, timeoutSecs);
      return;
    } catch {
      logWarn(`Command failed (attempt ${attempt}/${maxAttempts}): ${cmd.slice(0, 80)}...`);
      if (attempt < maxAttempts) {
        await sleep(sleepSec * 1000);
      }
    }
  }
  throw new Error(`runWithRetry exhausted: ${cmd.slice(0, 80)}...`);
}

// ─── Server Name ────────────────────────────────────────────────────────────

export async function getServerName(): Promise<string> {
  if (process.env.LIGHTSAIL_SERVER_NAME) {
    const name = process.env.LIGHTSAIL_SERVER_NAME;
    if (!validateServerName(name)) {
      logError(`Invalid LIGHTSAIL_SERVER_NAME: '${name}'`);
      throw new Error("Invalid server name");
    }
    logInfo(`Using instance name from environment: ${name}`);
    return name;
  }

  const kebab = process.env.SPAWN_NAME_KEBAB || (process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "");
  return kebab || defaultSpawnName();
}

export async function promptSpawnName(): Promise<void> {
  if (process.env.SPAWN_NAME_KEBAB) {
    return;
  }

  let kebab: string;
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    kebab = (process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "") || defaultSpawnName();
  } else {
    const derived = process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "";
    const fallback = derived || defaultSpawnName();
    process.stderr.write("\n");
    const answer = await prompt(`AWS instance name [${fallback}]: `);
    kebab = toKebabCase(answer || fallback) || defaultSpawnName();
  }

  process.env.SPAWN_NAME_DISPLAY = kebab;
  process.env.SPAWN_NAME_KEBAB = kebab;
  logInfo(`Using resource name: ${kebab}`);
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export async function destroyServer(name?: string): Promise<void> {
  const target = name || instanceName;
  if (!target) {
    throw new Error("destroy_server: no instance name provided");
  }

  logStep(`Destroying Lightsail instance '${target}'...`);

  if (lightsailMode === "cli") {
    try {
      await awsCli([
        "lightsail",
        "delete-instance",
        "--instance-name",
        target,
      ]);
    } catch {
      logError(`Failed to destroy Lightsail instance '${target}'`);
      logWarn(`Delete it manually: ${DASHBOARD_URL}`);
      throw new Error("Instance deletion failed");
    }
  } else {
    try {
      await lightsailRest(
        "Lightsail_20161128.DeleteInstance",
        JSON.stringify({
          instanceName: target,
          forceDeleteAddOns: false,
        }),
      );
    } catch {
      logError(`Failed to destroy Lightsail instance '${target}'`);
      logWarn(`Delete it manually: ${DASHBOARD_URL}`);
      throw new Error("Instance deletion failed");
    }
  }
  logInfo(`Instance '${target}' destroyed`);
}

export async function listServers(): Promise<void> {
  if (lightsailMode === "cli") {
    const proc = Bun.spawn(
      [
        "aws",
        "lightsail",
        "get-instances",
        "--query",
        "instances[].{Name:name,State:state.name,IP:publicIpAddress,Bundle:bundleId}",
        "--output",
        "table",
      ],
      {
        stdio: [
          "ignore",
          "inherit",
          "inherit",
        ],
        env: process.env,
      },
    );
    await proc.exited;
  } else {
    const resp = await lightsailRest("Lightsail_20161128.GetInstances", "{}");
    const data = parseJsonWith(resp, InstanceListSchema);
    const instances = data?.instances ?? [];
    const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
    console.log(pad("Name", 30) + pad("State", 12) + pad("IP", 16) + "Bundle");
    console.log("-".repeat(72));
    for (const i of instances) {
      console.log(
        pad(i.name || "", 30) + pad(i.state?.name || "", 12) + pad(i.publicIpAddress || "N/A", 16) + (i.bundleId || ""),
      );
    }
  }
}
