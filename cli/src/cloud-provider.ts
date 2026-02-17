/**
 * CloudProvider interface — TypeScript equivalent of the bash cloud adapter pattern.
 *
 * Each cloud's lib/common.sh exports these functions:
 *   cloud_authenticate()  → authenticate with the provider
 *   cloud_provision(name) → create a server
 *   cloud_wait_ready()    → wait for SSH/cloud-init
 *   cloud_run(cmd)        → run a command on the server
 *   cloud_upload(src,dst) → upload a file to the server
 *   cloud_interactive(cmd)→ start an interactive SSH session
 *   cloud_label()         → human-readable label
 *
 * This interface maps those 1:1, plus adds structured return types
 * and typed configuration that bash can't express.
 */

export interface ServerInfo {
  id: string;
  name: string;
  ip: string;
  user: string;
  cloud: string;
}

export interface CloudProviderConfig {
  /** API token or credentials */
  token: string;
  /** Server/instance type (e.g., "cpx11", "s-1vcpu-1gb") */
  serverType?: string;
  /** Region/location (e.g., "fsn1", "nyc1") */
  region?: string;
  /** OS image (e.g., "ubuntu-24.04") */
  image?: string;
  /** SSH public key content */
  sshPublicKey?: string;
}

export interface CloudProvider {
  /** Human-readable cloud name (e.g., "Hetzner Cloud") */
  readonly label: string;

  /** Short identifier (e.g., "hetzner", "digitalocean") */
  readonly id: string;

  /** Authenticate with the cloud provider. Throws on failure. */
  authenticate(config: CloudProviderConfig): Promise<void>;

  /** Ensure SSH key is registered with the provider. Returns the key ID/name. */
  ensureSSHKey(name: string, publicKey: string): Promise<string>;

  /** Provision a new server. Returns server info on success. */
  provision(name: string, config: CloudProviderConfig): Promise<ServerInfo>;

  /** Wait for the server to be ready (SSH reachable, cloud-init done). */
  waitReady(server: ServerInfo, timeoutSeconds?: number): Promise<void>;

  /** Run a command on the server. Returns stdout. */
  run(server: ServerInfo, command: string): Promise<string>;

  /** Upload a file to the server. */
  upload(server: ServerInfo, localPath: string, remotePath: string): Promise<void>;

  /** Start an interactive SSH session (hands control to the terminal). */
  interactive(server: ServerInfo, command?: string): Promise<void>;

  /** Destroy/delete the server. */
  destroy(server: ServerInfo): Promise<void>;
}

/**
 * CloudAPI — minimal typed wrapper for REST API calls.
 * Replaces the bash `generic_cloud_api()` function.
 */
export interface CloudAPIResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

export class CloudAPIError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "CloudAPIError";
  }
}

/**
 * Make an authenticated API request to a cloud provider.
 * This replaces the bash `generic_cloud_api()` curl wrapper.
 */
export async function cloudAPI<T = unknown>(
  baseURL: string,
  token: string,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<CloudAPIResponse<T>> {
  const url = `${baseURL}${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const init: RequestInit = { method, headers };
  if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(url, init);
  const data = (await resp.json()) as T;

  if (!resp.ok) {
    throw new CloudAPIError(resp.status, data, `${method} ${endpoint} failed with ${resp.status}`);
  }

  return { ok: resp.ok, status: resp.status, data };
}
