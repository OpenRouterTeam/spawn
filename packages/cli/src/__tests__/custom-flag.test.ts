import { describe, it, expect, afterEach } from "bun:test";
import { KNOWN_FLAGS, findUnknownFlag } from "../flags";

describe("--custom flag", () => {
  describe("flag registration", () => {
    it("should be in KNOWN_FLAGS", () => {
      expect(KNOWN_FLAGS.has("--custom")).toBe(true);
    });

    it("should not be detected as unknown flag", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
          "--custom",
        ]),
      ).toBeNull();
    });
  });
});

describe("AWS --custom prompts", () => {
  const savedCustom = process.env.SPAWN_CUSTOM;
  const savedRegion = process.env.AWS_DEFAULT_REGION;
  const savedLsRegion = process.env.LIGHTSAIL_REGION;
  const savedBundle = process.env.LIGHTSAIL_BUNDLE;
  const savedNonInteractive = process.env.SPAWN_NON_INTERACTIVE;

  afterEach(() => {
    restoreEnv("SPAWN_CUSTOM", savedCustom);
    restoreEnv("AWS_DEFAULT_REGION", savedRegion);
    restoreEnv("LIGHTSAIL_REGION", savedLsRegion);
    restoreEnv("LIGHTSAIL_BUNDLE", savedBundle);
    restoreEnv("SPAWN_NON_INTERACTIVE", savedNonInteractive);
  });

  it("promptRegion should skip prompt without --custom", async () => {
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.LIGHTSAIL_REGION;
    delete process.env.SPAWN_CUSTOM;
    const { promptRegion, getState } = await import("../aws/aws");
    await promptRegion();
    // Should use default without prompting
    expect(getState().awsRegion).toBe("us-east-1");
  });

  it("promptBundle should skip prompt without --custom", async () => {
    delete process.env.LIGHTSAIL_BUNDLE;
    delete process.env.SPAWN_CUSTOM;
    const { promptBundle } = await import("../aws/aws");
    // Should return without prompting (no error)
    await promptBundle();
  });

  it("promptRegion should respect env var over --custom", async () => {
    process.env.AWS_DEFAULT_REGION = "eu-west-1";
    process.env.SPAWN_CUSTOM = "1";
    const { promptRegion, getState } = await import("../aws/aws");
    await promptRegion();
    expect(getState().awsRegion).toBe("eu-west-1");
  });

  it("promptBundle should respect env var over --custom", async () => {
    process.env.LIGHTSAIL_BUNDLE = "small_3_0";
    process.env.SPAWN_CUSTOM = "1";
    const { promptBundle } = await import("../aws/aws");
    // Should use env var without prompting
    await promptBundle();
  });
});

describe("GCP --custom prompts", () => {
  const savedCustom = process.env.SPAWN_CUSTOM;
  const savedMachineType = process.env.GCP_MACHINE_TYPE;
  const savedZone = process.env.GCP_ZONE;

  afterEach(() => {
    restoreEnv("SPAWN_CUSTOM", savedCustom);
    restoreEnv("GCP_MACHINE_TYPE", savedMachineType);
    restoreEnv("GCP_ZONE", savedZone);
  });

  it("promptMachineType should return default without --custom", async () => {
    delete process.env.GCP_MACHINE_TYPE;
    delete process.env.SPAWN_CUSTOM;
    const { promptMachineType, DEFAULT_MACHINE_TYPE } = await import("../gcp/gcp");
    const result = await promptMachineType();
    expect(result).toBe(DEFAULT_MACHINE_TYPE);
  });

  it("promptZone should return default without --custom", async () => {
    delete process.env.GCP_ZONE;
    delete process.env.SPAWN_CUSTOM;
    const { promptZone, DEFAULT_ZONE } = await import("../gcp/gcp");
    const result = await promptZone();
    expect(result).toBe(DEFAULT_ZONE);
  });

  it("promptMachineType should respect env var", async () => {
    process.env.GCP_MACHINE_TYPE = "n2-standard-4";
    process.env.SPAWN_CUSTOM = "1";
    const { promptMachineType } = await import("../gcp/gcp");
    const result = await promptMachineType();
    expect(result).toBe("n2-standard-4");
  });

  it("promptZone should respect env var", async () => {
    process.env.GCP_ZONE = "europe-west1-b";
    process.env.SPAWN_CUSTOM = "1";
    const { promptZone } = await import("../gcp/gcp");
    const result = await promptZone();
    expect(result).toBe("europe-west1-b");
  });
});

describe("Hetzner --custom prompts", () => {
  const savedCustom = process.env.SPAWN_CUSTOM;
  const savedServerType = process.env.HETZNER_SERVER_TYPE;
  const savedLocation = process.env.HETZNER_LOCATION;

  afterEach(() => {
    restoreEnv("SPAWN_CUSTOM", savedCustom);
    restoreEnv("HETZNER_SERVER_TYPE", savedServerType);
    restoreEnv("HETZNER_LOCATION", savedLocation);
  });

  it("promptServerType should return default in non-interactive mode", async () => {
    delete process.env.HETZNER_SERVER_TYPE;
    delete process.env.SPAWN_CUSTOM;
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { promptServerType, DEFAULT_SERVER_TYPE } = await import("../hetzner/hetzner");
    const result = await promptServerType();
    expect(result).toBe(DEFAULT_SERVER_TYPE);
  });

  it("promptLocation should return default without --custom", async () => {
    delete process.env.HETZNER_LOCATION;
    delete process.env.SPAWN_CUSTOM;
    const { promptLocation, DEFAULT_LOCATION } = await import("../hetzner/hetzner");
    const result = await promptLocation();
    expect(result).toBe(DEFAULT_LOCATION);
  });

  it("promptServerType should respect env var", async () => {
    process.env.HETZNER_SERVER_TYPE = "cx32";
    process.env.SPAWN_CUSTOM = "1";
    const { promptServerType } = await import("../hetzner/hetzner");
    const result = await promptServerType();
    expect(result).toBe("cx32");
  });

  it("promptLocation should respect env var", async () => {
    process.env.HETZNER_LOCATION = "ash";
    process.env.SPAWN_CUSTOM = "1";
    const { promptLocation } = await import("../hetzner/hetzner");
    const result = await promptLocation();
    expect(result).toBe("ash");
  });
});

describe("DigitalOcean --custom prompts", () => {
  const savedCustom = process.env.SPAWN_CUSTOM;
  const savedSize = process.env.DO_DROPLET_SIZE;
  const savedRegion = process.env.DO_REGION;

  afterEach(() => {
    restoreEnv("SPAWN_CUSTOM", savedCustom);
    restoreEnv("DO_DROPLET_SIZE", savedSize);
    restoreEnv("DO_REGION", savedRegion);
  });

  it("promptDropletSize should return default without --custom", async () => {
    delete process.env.DO_DROPLET_SIZE;
    delete process.env.SPAWN_CUSTOM;
    const { promptDropletSize, DEFAULT_DROPLET_SIZE } = await import("../digitalocean/digitalocean");
    const result = await promptDropletSize();
    expect(result).toBe(DEFAULT_DROPLET_SIZE);
  });

  it("promptDoRegion should return default without --custom", async () => {
    delete process.env.DO_REGION;
    delete process.env.SPAWN_CUSTOM;
    const { promptDoRegion, DEFAULT_DO_REGION } = await import("../digitalocean/digitalocean");
    const result = await promptDoRegion();
    expect(result).toBe(DEFAULT_DO_REGION);
  });

  it("promptDropletSize should respect env var", async () => {
    process.env.DO_DROPLET_SIZE = "s-4vcpu-8gb";
    process.env.SPAWN_CUSTOM = "1";
    const { promptDropletSize } = await import("../digitalocean/digitalocean");
    const result = await promptDropletSize();
    expect(result).toBe("s-4vcpu-8gb");
  });

  it("promptDoRegion should respect env var", async () => {
    process.env.DO_REGION = "lon1";
    process.env.SPAWN_CUSTOM = "1";
    const { promptDoRegion } = await import("../digitalocean/digitalocean");
    const result = await promptDoRegion();
    expect(result).toBe("lon1");
  });
});

describe("Daytona --custom prompts", () => {
  const savedCustom = process.env.SPAWN_CUSTOM;
  const savedCpu = process.env.DAYTONA_CPU;
  const savedMemory = process.env.DAYTONA_MEMORY;
  const savedDisk = process.env.DAYTONA_DISK;

  afterEach(() => {
    restoreEnv("SPAWN_CUSTOM", savedCustom);
    restoreEnv("DAYTONA_CPU", savedCpu);
    restoreEnv("DAYTONA_MEMORY", savedMemory);
    restoreEnv("DAYTONA_DISK", savedDisk);
  });

  it("promptSandboxSize should return default without --custom", async () => {
    delete process.env.DAYTONA_CPU;
    delete process.env.DAYTONA_MEMORY;
    delete process.env.DAYTONA_DISK;
    delete process.env.SPAWN_CUSTOM;
    const { promptSandboxSize, DEFAULT_SANDBOX_SIZE } = await import("../daytona/daytona");
    const result = await promptSandboxSize();
    expect(result.cpu).toBe(DEFAULT_SANDBOX_SIZE.cpu);
    expect(result.memory).toBe(DEFAULT_SANDBOX_SIZE.memory);
    expect(result.disk).toBe(DEFAULT_SANDBOX_SIZE.disk);
  });

  it("promptSandboxSize should respect env vars", async () => {
    process.env.DAYTONA_CPU = "4";
    process.env.DAYTONA_MEMORY = "8";
    process.env.DAYTONA_DISK = "50";
    process.env.SPAWN_CUSTOM = "1";
    const { promptSandboxSize } = await import("../daytona/daytona");
    const result = await promptSandboxSize();
    expect(result.cpu).toBe(4);
    expect(result.memory).toBe(8);
    expect(result.disk).toBe(50);
  });
});

/** Helper to restore or delete an env var */
function restoreEnv(key: string, savedValue: string | undefined): void {
  if (savedValue !== undefined) {
    process.env[key] = savedValue;
  } else {
    delete process.env[key];
  }
}
