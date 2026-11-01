#!/usr/bin/env node
// Makes `tauri android build` repeatable on Windows. Two non-idempotent steps
// break a second run:
//
// 1) Every `tauri-plugin-*` build script runs
//    `tauri_plugin::Builder::android_path("android")`, which copies the tauri
//    Android library into `<crate>/android/.tauri/tauri-api`. The copy removes the
//    target first, then `create_dir`s every entry; Gradle output living inside the
//    folder (long `build/.transforms/...` paths) makes that removal fail silently,
//    so the next `create_dir` aborts with `os error 183`.
//
// 2) tauri-cli symlinks the freshly built `.so` files into
//    `gen/android/app/src/main/jniLibs/<abi>/`. Clobbering an existing symlink is
//    denied on Windows (`os error -2147024891`), so the second build fails.
//
// Both only touch generated output; crate sources stay untouched so Cargo's
// checksum verification keeps passing.
//
// Usage: `pnpm android:build -- --debug --features local-llm`

import { existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const registrySrc = join(cargoHome, "registry", "src");
const jniLibs = join(process.cwd(), "src-tauri", "gen", "android", "app", "src", "main", "jniLibs");

/** Removes a folder; falls back to a rename so a locked tree never blocks the build. */
function clearFolder(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (!existsSync(path)) return "removed";
  } catch {
    // Fall through to rename: Gradle may still hold handles on Windows.
  }
  try {
    const parked = `${path}.stale-${Date.now()}`;
    renameSync(path, parked);
    return `renamed ${parked}`;
  } catch (error) {
    return `failed (${error.message})`;
  }
}

/** Removes leftover `.tauri.stale-*` / `.tauri.bak-*` folders from earlier runs. */
function pruneBackups(dir) {
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!/^\.tauri\.(stale|bak)-/.test(name)) continue;
    const path = join(dir, name);
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed += 1;
    } catch {
      // Keep going; a pinned backup is harmless.
    }
  }
  return removed;
}

/** Drops the `.so` symlinks tauri-cli creates; Windows refuses to clobber them. */
function clearJniLibs() {
  if (!existsSync(jniLibs)) return 0;
  let removed = 0;
  for (const abi of readdirSync(jniLibs)) {
    const abiPath = join(jniLibs, abi);
    if (!statSync(abiPath).isDirectory()) continue;
    for (const name of readdirSync(abiPath)) {
      const path = join(abiPath, name);
      if (!lstatSync(path).isSymbolicLink()) continue;
      try {
        unlinkSync(path);
        removed += 1;
      } catch (error) {
        console.log(`[prepare-android] ${abi}/${name}: unlink failed (${error.message})`);
      }
    }
  }
  return removed;
}

function main() {
  const unlinked = clearJniLibs();
  console.log(`[prepare-android] removed ${unlinked} jniLibs symlink(s)`);

  if (!existsSync(registrySrc)) {
    console.log(`[prepare-android] no Cargo registry at ${registrySrc}, nothing to do`);
    return;
  }

  let cleared = 0;
  let backups = 0;

  for (const registry of readdirSync(registrySrc)) {
    const registryPath = join(registrySrc, registry);
    if (!statSync(registryPath).isDirectory()) continue;

    for (const crate of readdirSync(registryPath)) {
      if (!crate.startsWith("tauri-plugin")) continue;
      const cratePath = join(registryPath, crate);

      for (const platform of ["android", "ios"]) {
        const platformPath = join(cratePath, platform);
        if (!existsSync(platformPath)) continue;

        const tauriDir = join(platformPath, ".tauri");
        if (existsSync(tauriDir)) {
          console.log(`[prepare-android] ${crate}/${platform}: ${clearFolder(tauriDir)}`);
          cleared += 1;
        }
        backups += pruneBackups(platformPath);
      }
    }
  }

  console.log(
    `[prepare-android] cleared ${cleared} plugin generated folder(s), pruned ${backups} backup(s)`,
  );
}

main();
