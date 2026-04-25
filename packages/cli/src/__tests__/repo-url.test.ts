// Unit tests for normalizeRepoUrl — accepts any sane git URL, rejects
// anything with shell metacharacters or that could be parsed as a git flag.

import { describe, expect, it } from "bun:test";
import { normalizeRepoUrl } from "../shared/orchestrate.js";

describe("normalizeRepoUrl", () => {
  it("expands GitHub shorthand to a full HTTPS URL", () => {
    expect(normalizeRepoUrl("openrouterteam/spawn")).toBe("https://github.com/openrouterteam/spawn.git");
    expect(normalizeRepoUrl("user/my-repo")).toBe("https://github.com/user/my-repo.git");
    expect(normalizeRepoUrl("user.name/repo.dot")).toBe("https://github.com/user.name/repo.dot.git");
  });

  it("passes through HTTPS URLs unchanged", () => {
    expect(normalizeRepoUrl("https://github.com/user/repo.git")).toBe("https://github.com/user/repo.git");
    expect(normalizeRepoUrl("https://gitlab.com/user/repo")).toBe("https://gitlab.com/user/repo");
    expect(normalizeRepoUrl("http://gitea.example.internal/x/y")).toBe("http://gitea.example.internal/x/y");
    expect(normalizeRepoUrl("https://bitbucket.org/team/repo.git")).toBe("https://bitbucket.org/team/repo.git");
  });

  it("passes through SSH URLs", () => {
    expect(normalizeRepoUrl("ssh://git@github.com/user/repo.git")).toBe("ssh://git@github.com/user/repo.git");
    expect(normalizeRepoUrl("git://github.com/user/repo.git")).toBe("git://github.com/user/repo.git");
  });

  it("passes through SCP-style SSH (git@host:path)", () => {
    expect(normalizeRepoUrl("git@github.com:user/repo.git")).toBe("git@github.com:user/repo.git");
    expect(normalizeRepoUrl("deploy@gitlab.example.com:team/repo")).toBe("deploy@gitlab.example.com:team/repo");
  });

  it("rejects shell metacharacters", () => {
    expect(normalizeRepoUrl("user/repo; rm -rf /")).toBeNull();
    expect(normalizeRepoUrl("user/repo`whoami`")).toBeNull();
    expect(normalizeRepoUrl("$(curl evil)")).toBeNull();
    expect(normalizeRepoUrl("user/repo|cat")).toBeNull();
    expect(normalizeRepoUrl("user/repo && evil")).toBeNull();
    expect(normalizeRepoUrl('user/"repo"')).toBeNull();
  });

  it("rejects embedded whitespace and NUL bytes", () => {
    expect(normalizeRepoUrl("user / repo")).toBeNull();
    expect(normalizeRepoUrl("user/re po")).toBeNull();
    expect(normalizeRepoUrl("user\nrepo")).toBeNull();
    expect(normalizeRepoUrl("user/repo\0")).toBeNull();
  });

  it("rejects leading `-` (git option masquerade)", () => {
    expect(normalizeRepoUrl("--upload-pack=evil")).toBeNull();
    expect(normalizeRepoUrl("-bad/repo")).toBeNull();
  });

  it("rejects gibberish that's neither a URL nor a slug", () => {
    expect(normalizeRepoUrl("just-a-name")).toBeNull();
    expect(normalizeRepoUrl("")).toBeNull();
    expect(normalizeRepoUrl("   ")).toBeNull();
    expect(normalizeRepoUrl("/etc/passwd")).toBeNull();
    expect(normalizeRepoUrl("../../etc/passwd")).toBeNull();
  });

  it("rejects absurdly long inputs", () => {
    expect(normalizeRepoUrl(`https://github.com/${"x".repeat(600)}/y`)).toBeNull();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(normalizeRepoUrl("  user/repo  ")).toBe("https://github.com/user/repo.git");
  });
});
