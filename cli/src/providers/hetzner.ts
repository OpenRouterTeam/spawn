/**
 * Hetzner Cloud provider — TypeScript equivalent of hetzner/lib/common.sh.
 *
 * Proof-of-concept: demonstrates how a cloud provider can be implemented
 * in TypeScript using the CloudProvider interface, replacing ~600 lines
 * of bash with ~200 lines of typed, testable code.
 */
import type {
  CloudProvider,
  CloudProviderConfig,
  ServerInfo,
} from "../cloud-provider.js";
import { cloudAPI, CloudAPIError } from "../cloud-provider.js";
import {
  sshRun,
  scpUpload,
  sshInteractive,
  waitForSSH,
  waitForCloudInit,
} from "../ssh.js";

const API_BASE = "https://api.hetzner.cloud/v1";

interface HetznerSSHKey {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
}

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  public_net: {
    ipv4: { ip: string };
  };
  server_type: { name: string };
}

interface HetznerServerCreateResponse {
  server: HetznerServer;
}

interface HetznerSSHKeysResponse {
  ssh_keys: HetznerSSHKey[];
}

interface HetznerServersResponse {
  servers: HetznerServer[];
}

function api<T>(token: string, method: string, endpoint: string, body?: unknown) {
  return cloudAPI<T>(API_BASE, token, method, endpoint, body);
}

export class HetznerProvider implements CloudProvider {
  readonly label = "Hetzner Cloud";
  readonly id = "hetzner";

  private token = "";

  async authenticate(config: CloudProviderConfig): Promise<void> {
    this.token = config.token;

    // Validate the token by making a lightweight API call
    try {
      await api<HetznerServersResponse>(this.token, "GET", "/servers?per_page=1");
    } catch (err) {
      if (err instanceof CloudAPIError) {
        throw new Error(
          `Hetzner authentication failed (HTTP ${err.status}). ` +
          `Verify your token at: https://console.hetzner.cloud/projects -> API Tokens`,
        );
      }
      throw err;
    }
  }

  async ensureSSHKey(name: string, publicKey: string): Promise<string> {
    // Check if key already exists
    const { data } = await api<HetznerSSHKeysResponse>(this.token, "GET", "/ssh_keys");
    const existing = data.ssh_keys.find((k) => k.public_key.trim() === publicKey.trim());
    if (existing) {
      return String(existing.id);
    }

    // Register the key
    const { data: created } = await api<{ ssh_key: HetznerSSHKey }>(
      this.token,
      "POST",
      "/ssh_keys",
      { name, public_key: publicKey },
    );
    return String(created.ssh_key.id);
  }

  async provision(name: string, config: CloudProviderConfig): Promise<ServerInfo> {
    const serverType = config.serverType ?? "cpx11";
    const location = config.region ?? "fsn1";
    const image = config.image ?? "ubuntu-24.04";

    // Get all SSH key IDs for the account
    const { data: keysData } = await api<HetznerSSHKeysResponse>(
      this.token,
      "GET",
      "/ssh_keys",
    );
    const sshKeyIds = keysData.ssh_keys.map((k) => k.id);

    const { data } = await api<HetznerServerCreateResponse>(
      this.token,
      "POST",
      "/servers",
      {
        name,
        server_type: serverType,
        location,
        image,
        ssh_keys: sshKeyIds,
        start_after_create: true,
      },
    );

    return {
      id: String(data.server.id),
      name: data.server.name,
      ip: data.server.public_net.ipv4.ip,
      user: "root",
      cloud: this.id,
    };
  }

  async waitReady(server: ServerInfo, timeoutSeconds = 120): Promise<void> {
    await waitForSSH(server, timeoutSeconds);
    await waitForCloudInit(server, 60);
  }

  async run(server: ServerInfo, command: string): Promise<string> {
    return sshRun(server, command);
  }

  async upload(server: ServerInfo, localPath: string, remotePath: string): Promise<void> {
    return scpUpload(server, localPath, remotePath);
  }

  async interactive(server: ServerInfo, command?: string): Promise<void> {
    return sshInteractive(server, command);
  }

  async destroy(server: ServerInfo): Promise<void> {
    try {
      await api(this.token, "DELETE", `/servers/${server.id}`);
    } catch (err) {
      if (err instanceof CloudAPIError) {
        throw new Error(
          `Failed to destroy server ${server.id}. ` +
          `Delete it manually at: https://console.hetzner.cloud/`,
        );
      }
      throw err;
    }
  }
}
