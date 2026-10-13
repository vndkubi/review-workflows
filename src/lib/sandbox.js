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

function enabled() {
  return process.env.ARW_SANDBOX === 'docker';
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

// docker run arguments for one run (exported for tests).
function dockerArgs({ command, cwd, toolchain, name }) {
  const image = imageFor(toolchain);
  if (!image) throw new Error(`no sandbox image for ${toolchain}: set ARW_SANDBOX_IMAGE_${String(toolchain).toUpperCase()} (for pytest, an image with pytest installed)`);
  const args = ['run', '--rm', '--name', name, '--network', process.env.ARW_SANDBOX_NETWORK || 'none', '--memory', process.env.ARW_SANDBOX_MEMORY || '4g', '--cpus', process.env.ARW_SANDBOX_CPUS || '2', '--pids-limit', '512', '--security-opt', 'no-new-privileges', '-v', `${cwd}:/work`, '-w', '/work'];
  // A local Maven repository for builds without network (read-only unless
  // ARW_SANDBOX_M2_RW=1; Maven may need to write tracking files).
  if (process.env.ARW_SANDBOX_M2) args.push('-v', `${process.env.ARW_SANDBOX_M2}:/m2${process.env.ARW_SANDBOX_M2_RW === '1' ? '' : ':ro'}`, '-e', 'MAVEN_OPTS=-Dmaven.repo.local=/m2');
  if (typeof process.getuid === 'function') args.push('--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp');
  args.push(image, 'sh', '-c', toContainer(command, cwd));
  return args;
}

// Same contract as repro's shellRunner: { exit_code, timed_out, spawn_error, elapsed_ms }.
function dockerRunner({ command, cwd, logFile, timeoutMs, toolchain }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const name = `arw-${crypto.randomBytes(6).toString('hex')}`;
    let args;
    try {
      args = dockerArgs({ command, cwd, toolchain, name });
    } catch (err) {
      fs.writeFileSync(logFile, `${err.message}\n`);
      resolve({ exit_code: null, spawn_error: err.message, elapsed_ms: 0 });
      return;
    }
    const out = fs.openSync(logFile, 'w');
    fs.writeSync(out, `$ docker ${args.join(' ')}\n`);
    let timedOut = false;
    const child = spawn('docker', args, { stdio: ['ignore', out, out], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        execFileSync('docker', ['kill', name], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      fs.closeSync(out);
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

module.exports = { enabled, imageFor, dockerArgs, dockerRunner, toContainer, DEFAULT_IMAGES };
