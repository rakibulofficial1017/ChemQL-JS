#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { HELP, execute_query_text, process_lines, reset_session } from "../src/index.js";

const version = "0.2.1";
const history = [];

function render(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(render).join("\n");
  if (value instanceof Map) return value.toString();
  if (typeof value === "object" && typeof value.toString === "function") return value.toString();
  return String(value);
}

async function run() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg === "-v" || arg === "--version")) {
    console.log(version);
    return;
  }
  if (args[0] === "-h" || args[0] === "--help" || args[0] === "?") {
    console.log(HELP);
    return;
  }
  if (args[0] === "-c") {
    if (args.length < 2) throw new Error("Usage: chemql-js -c <command>");
    const command = args.slice(1).join(" ");
    history.push(command);
    console.log(render(await execute_query_text(command)));
    return;
  }
  if (args[0] === "-f") {
    if (args.length !== 2) throw new Error("Usage: chemql-js -f <file>");
    const contents = await readFile(args[1], "utf8");
    for (const line of contents.split(/\r?\n/)) {
      if (line.trim()) history.push(line);
    }
    console.log(render(await process_lines(contents.split(/\r?\n/))));
    return;
  }
  if (args.length) throw new Error(`Unknown option \`${args[0]}\``);

  const terminal = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
  let pending = "";
  let blockDepth = 0;
  const prompt = () => {
    if (!input.isTTY) return;
    terminal.setPrompt(blockDepth || pending ? "... " : ">>> ");
    terminal.prompt();
  };
  try {
    prompt();
    for await (const line of terminal) {
      const continued = line.trimEnd().endsWith("\\");
      pending += (pending ? "\n" : "") + (continued ? line.trimEnd().slice(0, -1) : line);
      if (continued) {
        prompt();
        continue;
      }
      if (/^\[(?:if|for|while)\b[\s\S]*\]$/.test(line.trim())) blockDepth += 1;
      else if (line.trim() === "[endblock]") blockDepth -= 1;
      if (blockDepth > 0) {
        prompt();
        continue;
      }
      const command = pending.trim();
      pending = "";
      if (!command) {
        prompt();
        continue;
      }
      if (["exit", "quit"].includes(command.toLowerCase())) break;
      if (command.startsWith("dump ")) {
        const filename = command.slice(5).trim();
        if (!filename) {
          console.log("Usage: dump <file>");
          prompt();
          continue;
        }
        const { writeFile } = await import("node:fs/promises");
        await writeFile(filename, `${history.join("\n")}\n`, "utf8");
        console.log(`Session dumped to ${filename}`);
        prompt();
        continue;
      }
      history.push(command);
      try {
        const result = await process_lines(command.split(/\r?\n/));
        if (result != null) console.log(render(result));
      } catch (error) {
        console.error(`${error.name}: ${error.message}`);
      }
      prompt();
    }
  } finally {
    terminal.close();
    reset_session();
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
