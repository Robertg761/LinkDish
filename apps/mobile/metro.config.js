const fs = require("node:fs");
const path = require("node:path");

const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest;

config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), workspaceRoot]));
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules")
];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("./node_modules/")) {
    return context.resolveRequest(context, moduleName.replace(/^\.\/node_modules\//, ""), platform);
  }

  if (moduleName.endsWith(".js") && moduleName.startsWith(".")) {
    const tsModulePath = path
      .resolve(path.dirname(context.originModulePath), moduleName)
      .replace(/\.js$/, ".ts");

    if (fs.existsSync(tsModulePath)) {
      return {
        filePath: tsModulePath,
        type: "sourceFile"
      };
    }
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
