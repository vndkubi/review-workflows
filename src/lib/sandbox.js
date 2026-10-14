'use strict';
// Running PR code (reproduction tests, impacted tests) in a container instead
// of on the host. A worktree only separates files from the user's checkout;
// a build can still read anything the user can, reach the network and
// spawn processes. With ARW_SANDBOX=docker each run is a throwaway container:
//   - only the worktree is mounted (at /work), plus mounts you add;
//   - no network unless ARW_SANDBOX_NETWORK says otherwise;
//   - memory, CPU and process limits; killed on timeout;
//   - no environment from the host except what the image sets.
// Images per toolchain: ARW_SANDBOX_IMAGE_MAVEN / _GRADLE / _PYTEST (an image
// with pytest installed), or ARW_SANDBOX_IMAGE for all. Maven without network
// needs its dependencies: mount a repository with ARW_SANDBOX_M2 (read-only).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const DEFAULT_IMAGES = { maven: 'maven:3.9-eclipse-temurin-17', gradle: 'gradle:8-jdk17' };

// The docker CLI (ARW_DOCKER: another path, or a compatible CLI).
function dockerBin() {
  return process.env.ARW_DOCKER || 'docker';
}

// ARW_SANDBOX=docker: containers with the configured images (and ARW_SANDBOX_M2);
// ARW_SANDBOX=bootstrap: containers prepared per repository by bootstrap
// (discovered image, dependency cache resolved at base, staged artifacts).
function mode() {
  return ['docker', 'bootstrap'].includes(process.env.ARW_SANDBOX) ? process.env.ARW_SANDBOX : 'host';
}

function enabled() {
  return mode() !== 'host';
}

function imageFor(toolchain) {
  const key = `ARW_SANDBOX_IMAGE_${String(toolchain || '').toUpperCase()}`;
  return process.env[key] || process.env.ARW_SANDBOX_IMAGE || DEFAULT_IMAGES[toolchain] || null;
}

// Host paths in the command become container paths.
function toContainer(command, hostDir) {
  const variants = [hostDir, hostDir.replace(/\\/g, '/'), hostDir.replace(/\//g, '\\')];
  let out = command;
  for (const v of [...new Set(variants)].sort((a, b) => b.length - a.length)) out = out.split(v).join('/work');
  return out.replace(/\/work\\/g, '/work/');
}

// docker run arguments for one run (exported for tests). With argv the
// image runs that program directly, no shell; a configured test_command
// (a string) still runs through sh -c.
// Extra mounts a caller (bootstrap) may add: absolute paths on both sides,
// never the docker socket or the container root.
function checkMount(m) {
  if (!m || !path.isAbsolute(String(m.host)) || !/^\/[A-Za-z0-9_./-]+$/.test(String(m.container)) || m.container === '/' || m.container === '/work') throw new Error(`bad mount ${JSON.stringify(m)}`);
  if (/docker\.sock|[\\/]var[\\/]run[\\/]docker/i.test(m.host)) throw new Error(`refusing to mount ${m.host}`);
  return `${m.host}:${m.container}${m.readonly ? ':ro' : ''}`;
}

// `image`, `network` and `mounts` override the defaults for one run
// (bootstrap); with `mounts`, ARW_SANDBOX_M2 is not mounted.
function dockerArgs({ command, argv = null, cwd, toolchain, name, image = null, network = null, mounts = null, env = null }) {
  image = image || imageFor(toolchain);
  if (!image) throw new Error(`no sandbox image for ${toolchain}: set ARW_SANDBOX_IMAGE_${String(toolchain).toUpperCase()} (for pytest, an image with pytest installed)`);
  const args = ['run', '--rm', '--name', name, '--network', network || process.env.ARW_SANDBOX_NETWORK || 'none', '--memory', process.env.ARW_SANDBOX_MEMORY || '4g', '--cpus', process.env.ARW_SANDBOX_CPUS || '2', '--pids-limit', '512', '--security-opt', 'no-new-privileges', '-v', `${cwd}:/work`, '-w', '/work'];
  if (mounts) for (const m of mounts) args.push('-v', checkMount(m));
  // A local Maven repository for builds without network (read-only unless
  // ARW_SANDBOX_M2_RW=1; Maven may need to write tracking files).
  else if (process.env.ARW_SANDBOX_M2) args.push('-v', `${process.env.ARW_SANDBOX_M2}:/m2${process.env.ARW_SANDBOX_M2_RW === '1' ? '' : ':ro'}`, '-e', 'MAVEN_OPTS=-Dmaven.repo.local=/m2');
  for (const [k, v] of Object.entries(env || {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || /[\r\n]/.test(String(v))) throw new Error(`bad container environment ${k}`);
    args.push('-e', `${k}=${v}`);
  }
  if (typeof process.getuid === 'function') args.push('--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp');
  if (argv) args.push(image, ...argv.map((a) => toContainer(String(a), cwd)));
  else args.push(image, 'sh', '-c', toContainer(command, cwd));
  return args;
}

// Whether the docker daemon answers; a failure is remembered for a minute,
// success for the process. Without it a run would fail like a build does
// (exit 1) and be misread as the PR's failure.
let daemon = { ok: false, at: 0, error: null };
function daemonError() {
  if (daemon.ok) return null;
  if (daemon.error && Date.now() - daemon.at < 60000) return daemon.error;
  try {
    execFileSync(dockerBin(), ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe', timeout: 30000, windowsHide: true });
    daemon = { ok: true, at: Date.now(), error: null };
    return null;
  } catch (err) {
    const why = err.code === 'ENOENT' ? `${dockerBin()} not found` : String((err.stderr && err.stderr.toString().trim()) || err.message).split('\n')[0];
    daemon = { ok: false, at: Date.now(), error: `docker is not available: ${why}` };
    return daemon.error;
  }
}

// Same contract as repro's shellRunner: { exit_code, timed_out, spawn_error, elapsed_ms }.
// No docker means ENVIRONMENT_BLOCKED, never a run on the host.
function dockerRunner({ command, argv = null, cwd, logFile, timeoutMs, toolchain, image = null, network = null, mounts = null, env = null }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const name = `arw-${crypto.randomBytes(6).toString('hex')}`;
    let args;
    try {
      const unavailable = daemonError();
      if (unavailable) throw new Error(unavailable);
      args = dockerArgs({ command, argv, cwd, toolchain, name, image, network, mounts, env });
    } catch (err) {
      fs.writeFileSync(logFile, `${err.message}\n`);
      resolve({ exit_code: null, spawn_error: err.message, elapsed_ms: 0 });
      return;
    }
    const out = fs.openSync(logFile, 'w');
    fs.writeSync(out, `$ docker ${args.join(' ')}\n`);
    let timedOut = false;
    const child = spawn(dockerBin(), args, { stdio: ['ignore', out, out], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        execFileSync(dockerBin(), ['kill', name], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      try {
        fs.closeSync(out);
      } catch {
        /* closed */
      }
      resolve({ exit_code: null, spawn_error: `docker: ${err.message}`, elapsed_ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.closeSync(out);
      } catch {
        /* closed */
      }
      // 125: docker itself failed (no image, bad flags); 127: command not found in the image.
      const spawnError = code === 125 ? 'docker could not start the container (image missing?)' : code === 127 ? 'command not found in the sandbox image' : null;
      resolve({ exit_code: code, timed_out: timedOut, spawn_error: spawnError, elapsed_ms: Date.now() - started });
    });
  });
}

// Where and how PR code runs, for the frozen execution manifest: the host
// shell, or docker with its image, network, limits and mounts. Image tags
// can move; pin with name@sha256:<digest> to make them exact.
function manifest() {
  if (!enabled()) return { mode: 'host' };
  // Bootstrap environments record their own image and inputs per run.
  if (mode() === 'bootstrap') return { mode: 'bootstrap', docker: dockerBin(), resolve_network: process.env.ARW_SANDBOX_RESOLVE_NETWORK || 'bridge', memory: process.env.ARW_SANDBOX_MEMORY || '4g', cpus: process.env.ARW_SANDBOX_CPUS || '2', pytest_image: imageFor('pytest'), python: process.env.ARW_PYTHON || 'python' };
  return {
    mode: 'docker',
    docker: dockerBin(),
    images: Object.fromEntries(['maven', 'gradle', 'pytest'].map((t) => [t, imageFor(t)])),
    network: process.env.ARW_SANDBOX_NETWORK || 'none',
    memory: process.env.ARW_SANDBOX_MEMORY || '4g',
    cpus: process.env.ARW_SANDBOX_CPUS || '2',
    m2: process.env.ARW_SANDBOX_M2 ? (process.env.ARW_SANDBOX_M2_RW === '1' ? 'rw' : 'ro') : null,
    python: process.env.ARW_PYTHON || 'python',
  };
}

module.exports = { enabled, mode, imageFor, dockerArgs, dockerRunner, toContainer, manifest, daemonError, DEFAULT_IMAGES, _resetDaemon: () => { daemon = { ok: false, at: 0, error: null }; } };
