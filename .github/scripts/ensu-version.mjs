#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const files = {
    packageJson: path.join(root, "rust/apps/ensu/package.json"),
    tauri: path.join(root, "rust/apps/ensu/src-tauri/tauri.conf.json"),
    cargoToml: path.join(root, "rust/apps/ensu/src-tauri/Cargo.toml"),
    cargoLock: path.join(root, "rust/apps/ensu/src-tauri/Cargo.lock"),
    android: path.join(root, "mobile/native/android/apps/ensu/app-ui/build.gradle.kts"),
    xcode: path.join(root, "mobile/native/darwin/Apps/Ensu/Ensu.xcodeproj/project.pbxproj"),
    plist: path.join(root, "mobile/native/darwin/Apps/Ensu/Ensu/Info.plist"),
};

function read(file) {
    return fs.readFileSync(file, "utf8");
}

function write(file, text) {
    fs.writeFileSync(file, text);
}

function sourceVersion() {
    const version = JSON.parse(read(files.packageJson)).version;
    const match = /^(\d+\.\d+\.\d+)(-beta)?$/.exec(version);
    if (!match) throw new Error(`Invalid Ensu desktop version: ${version}`);
    return {
        version: match[1],
        channel: match[2] ? "beta" : "stable",
    };
}

function desktopVersion(version, channel) {
    return channel === "beta" ? `${version}-beta` : version;
}

function value(file, regex) {
    return read(file).match(regex)?.[1];
}

function replace(file, regex, replacement) {
    const text = read(file);
    let count = 0;
    const next = text.replace(regex, (...args) => {
        count += 1;
        return typeof replacement === "function" ? replacement(...args) : replacement;
    });
    if (!count) throw new Error(`No match in ${path.relative(root, file)}`);
    write(file, next);
}

function expect(label, actual, wanted) {
    if (actual !== wanted) throw new Error(`${label}: expected ${wanted}, found ${actual}`);
}

function check() {
    const { version, channel } = sourceVersion();
    const desktop = desktopVersion(version, channel);

    expect("tauri.conf.json", JSON.parse(read(files.tauri)).package?.version, desktop);
    expect("Cargo.toml", value(files.cargoToml, /\[package\][\s\S]*?^version = "([^"]+)"/m), desktop);
    expect("Cargo.lock", value(files.cargoLock, /\[\[package\]\]\nname = "ensu-tauri"\nversion = "([^"]+)"/), desktop);
    expect("Android versionName", value(files.android, /versionName = "([^"]+)"/), version);
    expect("Info.plist", value(files.plist, /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/), version);

    for (const match of read(files.xcode).matchAll(/MARKETING_VERSION = ([^;]+);/g)) {
        expect("Xcode MARKETING_VERSION", match[1], version);
    }
}

function setVersion(version, channel) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
    if (!["beta", "stable"].includes(channel)) throw new Error(`Invalid channel: ${channel}`);

    const desktop = desktopVersion(version, channel);
    const packageJson = JSON.parse(read(files.packageJson));
    packageJson.version = desktop;
    write(files.packageJson, `${JSON.stringify(packageJson, null, 2)}\n`);

    replace(files.tauri, /("package"\s*:\s*\{[\s\S]*?"version"\s*:\s*")[^"]+(")/, (_m, a, b) => `${a}${desktop}${b}`);
    replace(files.cargoToml, /(\[package\][\s\S]*?^version = ")[^"]+(")/m, (_m, a, b) => `${a}${desktop}${b}`);
    replace(files.cargoLock, /(\[\[package\]\]\nname = "ensu-tauri"\nversion = ")[^"]+(")/, (_m, a, b) => `${a}${desktop}${b}`);
    replace(files.android, /versionName = "[^"]+"/, `versionName = "${version}"`);
    replace(files.xcode, /MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
    replace(files.plist, /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/, (_m, a, b) => `${a}${version}${b}`);
}

function usage() {
    console.error(`Usage:
  node .github/scripts/ensu-version.mjs check
  node .github/scripts/ensu-version.mjs github-output
  node .github/scripts/ensu-version.mjs set --version 0.1.16 --channel beta
  node .github/scripts/ensu-version.mjs set --version 0.1.16 --channel stable`);
}

const [command = "check", ...args] = process.argv.slice(2);

try {
    if (command === "check") {
        check();
    } else if (command === "github-output") {
        const version = sourceVersion();
        console.log(`version=${version.version}`);
        console.log(`channel=${version.channel}`);
    } else if (command === "set") {
        setVersion(args[args.indexOf("--version") + 1], args[args.indexOf("--channel") + 1]);
    } else {
        usage();
        process.exit(2);
    }
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
