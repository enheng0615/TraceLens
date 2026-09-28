import * as pi from "@mariozechner/pi-agent-core";

if (typeof pi.Agent !== "function") {
  throw new Error("Pi Agent Core loaded, but the Agent export is unavailable.");
}

console.log("Pi Agent Core is installed and loadable.");
console.log(`Available exports: ${Object.keys(pi).sort().join(", ")}`);
