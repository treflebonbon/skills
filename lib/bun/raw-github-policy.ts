export type GitHubPolicy = {
  repository: string;
  branch: string;
  default_branch: string;
  reviewed_commit: string;
  automation: "no-project-secrets" | "human-reviewed-external";
  review: string;
};

const fields = [
  "repository",
  "branch",
  "default_branch",
  "reviewed_commit",
  "automation",
  "review",
] as const;

export function validateGitHubPolicy(value: unknown): GitHubPolicy {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((name) => Object.hasOwn(value, name))
  )
    throw new Error(
      "GitHub policy requires repository, branch, default_branch, reviewed_commit, automation and review",
    );

  const record = value as Record<(typeof fields)[number], unknown>;
  if (!fields.every((name) => typeof record[name] === "string" && record[name]))
    throw new Error("GitHub policy values must be nonempty strings");

  const policy = value as GitHubPolicy;
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+(?![\s\S])/.test(policy.repository))
    throw new Error("GitHub policy requires an owner/repository");
  if (!/^[a-f0-9]{40}(?![\s\S])/.test(policy.reviewed_commit))
    throw new Error("GitHub policy requires a full reviewed commit SHA");
  if (["main", "master", policy.default_branch].includes(policy.branch))
    throw new Error("GitHub policy must select a topic branch");
  if (
    ![policy.branch, policy.default_branch].every((name) =>
      /^[A-Za-z0-9][A-Za-z0-9/_.-]*(?![\s\S])/.test(name),
    )
  )
    throw new Error("GitHub policy contains an unsupported branch name");
  if (!["no-project-secrets", "human-reviewed-external"].includes(policy.automation))
    throw new Error(
      "review secret-free automation or human-reviewed external execution before enabling GitHub",
    );
  return policy;
}
