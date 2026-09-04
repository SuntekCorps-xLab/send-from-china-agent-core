import { spawnSync } from "node:child_process";

const MINIMUM_PYTHON = Object.freeze({ major: 3, minor: 11 });

function parsedVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(value || "").trim());
  if (!match) return null;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  });
}
function supported(version) {
  return version
    && (version.major > MINIMUM_PYTHON.major
      || (version.major === MINIMUM_PYTHON.major && version.minor >= MINIMUM_PYTHON.minor));
}

function failureMessage(observed = []) {
  const detail = observed.length
    ? ` Detected unsupported or unusable candidates: ${observed.join(", ")}.`
    : "";
  return `Python 3.11+ is required. Set PYTHON=/path/to/python3.11.${detail}`;
}

export function resolvePythonRuntime(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const probe = options.probe || spawnSync;
  const configured = String(env.PYTHON || "").trim();
  const candidates = configured
    ? [configured]
    : (platform === "win32" ? ["python"] : ["python3", "python"]);
  const observed = [];

  for (const executable of candidates) {
    const result = probe(executable, [
      "-c",
      "import sys; print('.'.join(str(value) for value in sys.version_info[:3]))",
    ], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (result?.error?.code === "ENOENT") continue;
    const version = result?.status === 0 ? parsedVersion(result.stdout) : null;
    if (supported(version)) return Object.freeze({ executable, version });
    observed.push(version ? `${executable} ${version.major}.${version.minor}.${version.patch}` : executable);
  }

  throw new Error(failureMessage(observed));
}
