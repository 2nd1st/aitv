// 部署 / 发布前的闸门：只允许从干净的 main、且 HEAD == origin/main（先 git fetch）的仓库发出去。
// 不满足就报错退出——这是为了不再出现「从别人正在改的分支 / 工作区部署」的事故。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// 纯函数，便于测试
export function guardProblems({ branch, porcelain, head, originMain }) {
  const p = [];
  if (branch !== "main") p.push(`当前分支是「${branch || "(detached)"}」，只能从 main 部署 / 发布`);
  if (porcelain) p.push(`工作区不干净：\n${porcelain.split("\n").map((l) => "    " + l).join("\n")}`);
  if (!head || head !== originMain) p.push(`HEAD ${head?.slice(0, 7)} ≠ origin/main ${originMain?.slice(0, 7)}：先提交并 push（或 pull）`);
  return p;
}

export function gitGuard() {
  git("fetch", "-q", "origin", "main");
  const state = {
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    porcelain: git("status", "--porcelain", "--untracked-files=normal"),
    head: git("rev-parse", "HEAD"),
    originMain: git("rev-parse", "origin/main"),
  };
  const problems = guardProblems(state);
  if (problems.length) {
    console.error("✗ 拒绝：\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  return { commit: state.head, root: ROOT };
}
