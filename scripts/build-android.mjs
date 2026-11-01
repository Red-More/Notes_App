#!/usr/bin/env node
// Android build wrapper: prepares the toolchain environment, clears generated
// artifacts, then runs `tauri android build` with the arguments given here.
//
// Why a wrapper: llama-cpp-sys-2 auto-picks the *newest* NDK under the SDK and
// only accepts one that ships `build/cmake/android.toolchain.cmake`. On this
// machine the newest NDK (30.x) is an incomplete install, so the build panics
// unless ANDROID_NDK points at a complete one. cmake and ninja are also not on
// PATH by default. Pinning all of this here keeps the build one command and
// keeps it reproducible for anyone who clones the project.
//
// Usage: `pnpm android:build:local` (equivalent to `node scripts/build-android.mjs --debug --features local-llm`)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

await import("./prepare-android-plugins.mjs");

const projectRoot = process.cwd();
const sdkRoot =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "AppData", "Local", "Android", "Sdk");

const fail = (message) => {
  console.error(`[android-build] ${message}`);
  process.exit(1);
};

/** Highest NDK version that actually ships the CMake toolchain file. */
function pickNdk() {
  const explicit = process.env.ANDROID_NDK ?? process.env.ANDROID_NDK_HOME;
  if (explicit && existsSync(join(explicit, "build", "cmake", "android.toolchain.cmake"))) {
    return explicit;
  }
  const ndkRoot = join(sdkRoot, "ndk");
  if (!existsSync(ndkRoot)) return null;

  const versions = readdirSync(ndkRoot).filter((name) =>
    existsSync(join(ndkRoot, name, "build", "cmake", "android.toolchain.cmake")),
  );
  if (versions.length === 0) return null;

  const rank = (value) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  versions.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
    }
    return 0;
  });
  return join(ndkRoot, versions[versions.length - 1]);
}

/** minSdkVersion from tauri.conf.json, falling back to 24. */
function minSdkVersion() {
  try {
    const config = JSON.parse(readFileSync(join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"));
    const value = config?.bundle?.android?.minSdkVersion;
    if (Number.isInteger(value) && value > 0) return value;
  } catch {
    // Fall through to the default.
  }
  return 24;
}

/** VS Build Tools ships cmake/ninja outside PATH; prepend them when missing. */
function ensureBuildTools(pathParts) {
  if (spawnSync("cmake", ["--version"], { shell: true, stdio: "ignore" }).status === 0) return;

  const roots = [
    "C:\\Program Files (x86)\\Microsoft Visual Studio",
    "C:\\Program Files\\Microsoft Visual Studio",
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root)) {
      const base = join(root, version);
      for (const edition of readdirSync(base)) {
        const cmakeBin = join(
          base,
          edition,
          "Common7",
          "IDE",
          "CommonExtensions",
          "Microsoft",
          "CMake",
          "CMake",
          "bin",
        );
        const ninjaBin = join(
          base,
          edition,
          "Common7",
          "IDE",
          "CommonExtensions",
          "Microsoft",
          "CMake",
          "Ninja",
        );
        if (!existsSync(join(cmakeBin, "cmake.exe"))) continue;
        pathParts.unshift(cmakeBin);
        if (existsSync(ninjaBin)) pathParts.unshift(ninjaBin);
        return;
      }
    }
  }
}

const ndk = pickNdk();
if (!ndk) {
  fail(
    `no usable NDK under ${join(sdkRoot, "ndk")}. Install one that includes build/cmake/android.toolchain.cmake (NDK r28+ also satisfies the 16 KB page requirement).`,
  );
}

const apiLevel = String(minSdkVersion());
const bin = join(ndk, "toolchains", "llvm", "prebuilt", "windows-x86_64", "bin");
const suffix = existsSync(join(bin, `aarch64-linux-android${apiLevel}-clang.cmd`))
  ? `aarch64-linux-android${apiLevel}`
  : "aarch64-linux-android";

const env = { ...process.env };
const pathParts = [bin];

env.ANDROID_NDK = ndk;
env.ANDROID_NDK_HOME = ndk;
env.ANDROID_NDK_ROOT = ndk;
env.CARGO_NDK_ANDROID_NDK = ndk;
env.ANDROID_API_LEVEL = apiLevel;
env.CC_aarch64_linux_android = join(bin, `${suffix}-clang.cmd`);
env.CXX_aarch64_linux_android = join(bin, `${suffix}-clang++.cmd`);
env.AR_aarch64_linux_android = join(bin, "llvm-ar.exe");
env.CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = join(bin, `${suffix}-clang.cmd`);
env.CMAKE_GENERATOR = "Ninja";

if (!env.LIBCLANG_PATH) {
  const libclang = join(homedir(), "miniconda3", "Lib", "site-packages", "clang", "native");
  if (existsSync(join(libclang, "libclang.dll"))) env.LIBCLANG_PATH = libclang;
}

ensureBuildTools(pathParts);
env.PATH = `${pathParts.join(";")};${env.PATH}`;

console.log(`[android-build] NDK ${ndk} (API ${apiLevel})`);
console.log(`[android-build] LIBCLANG_PATH ${env.LIBCLANG_PATH ?? "(unset)"}`);

const args = process.argv.slice(2).filter((arg) => arg !== "--print-env");
if (process.argv.includes("--print-env")) {
  console.log(
    JSON.stringify(
      {
        ndk,
        apiLevel,
        cc: env.CC_aarch64_linux_android,
        linker: env.CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER,
        libclang: env.LIBCLANG_PATH ?? null,
        cmake: spawnSync("cmake", ["--version"], { env, shell: true, encoding: "utf8" })
          .stdout?.split("\n")[0],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const exitCode = spawnSync(`pnpm exec tauri android build ${args.join(" ")}`, {
  cwd: projectRoot,
  env,
  shell: true,
  stdio: "inherit",
}).status;

process.exit(exitCode ?? 1);
