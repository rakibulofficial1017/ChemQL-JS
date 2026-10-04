import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(packageDir, "../data");
const [
  periodicTable,
  moleculeData,
  reactionData,
  moleculeBonds,
  bondEnergies,
] = await Promise.all([
  "PeriodicTableJSON.json",
  "Molecules.json",
  "Reactions.json",
  "MoleculeBonds.json",
  "BondEnergies.json",
].map(async (name) => JSON.parse(await readFile(path.join(dataDir, name), "utf8"))));

export class Unknown {
  constructor(value = null) {
    this.value = value;
  }

  toString() {
    return this.value == null ? "Unknown" : String(this.value);
  }
}

export class ChemQLError extends Error {
  constructor(message, position = null, length = 1) {
    super(message);
    this.name = "ChemQLError";
    this.position = position;
    this.length = length;
  }
}

export class Element {
  constructor(data) {
    for (const [key, value] of Object.entries(data)) {
      this[key === "cpk-hex" ? "cpk_hex" : key] = value ?? "";
    }
    this["cpk-hex"] = this.cpk_hex;
  }

  get(key) {
    return this[key];
  }

  toString() {
    const digits = String(Math.floor(Number(this.atomic_mass) + 0.5));
    const color = /^[\da-f]{6}$/i.test(this.cpk_hex) ? this.cpk_hex : "ffffff";
    const [r, g, b] = color.match(/../g).map((part) => Number.parseInt(part, 16));
    const centered = (text, width = 3) => String(text).padStart((width + String(text).length) >> 1).padEnd(width);
    return `\u001b[38;2;${r};${g};${b}m ______________\n|     ${centered(this.number)}      |\n|              |\n|     ${centered(this.symbol)}      |\n|              |\n|     ${centered(digits)}      |\n|______________|\u001b[0m\n`;
  }
}

const elementKeys = [
  "name", "appearance", "atomic_mass", "boil", "category", "density",
  "discovered_by", "melt", "molar_heat", "named_by", "number", "period",
  "group", "phase", "source", "bohr_model_image", "bohr_model_3d",
  "spectral_img", "summary", "symbol", "xpos", "ypos", "wxpos", "wypos",
  "shells", "electron_configuration", "electron_configuration_semantic",
  "electron_affinity", "electronegativity_pauling", "ionization_energies",
  "cpk-hex", "image", "block",
];

export const ELEMENTS = periodicTable.elements
  .slice(0, -1)
  .map((entry) => new Element(entry));

export class Molecule {
  constructor(data) {
    Object.assign(this, data);
    this.iupac_name ??= "";
    this.smiles ??= "";
    this.bonds = moleculeBonds[this.name]?.bonds ?? [];
    this.total_bond_energy = this.bonds.reduce((total, bond) => {
      const key = `${[...bond.elements].sort().join("-")}-${bond.type}`;
      return total + (bond.count ?? 0) * (bondEnergies[key]?.energy ?? 0);
    }, 0);
  }

  get(key) {
    return this[key];
  }

  toString() {
    const subscripts = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉" };
    return `${String(this.formula).replace(/\d/g, (digit) => subscripts[digit])} (${this.name})`;
  }
}

export const MOLECULES = moleculeData.map((item) => new Molecule(item));
export const MOLECULES_BY_FORMULA = new Map(MOLECULES.map((item) => [item.formula, item]));
export const moleculeKeys = [
  "name", "formula", "elements", "molecular_weight", "iupac_name", "smiles",
  "cid", "melting_point", "boiling_point", "density", "state", "bonds",
  "total_bond_energy",
];

export function molecule_bond_energy(formula) {
  return MOLECULES_BY_FORMULA.get(formula)?.total_bond_energy ?? 0;
}

const subscript = (value) => String(value).replace(/\d/g, (digit) =>
  String.fromCharCode(0x2080 + Number(digit)));

export class Reaction {
  constructor(data) {
    Object.assign(this, data);
    this.source ??= "";
    const reactants = this.reactants.map((part) => `${part.stoichiometric_coefficient} ${subscript(part.molecule)}`).join(" + ");
    const products = this.products.map((part) => `${part.stoichiometric_coefficient} ${subscript(part.molecule)}`).join(" + ");
    const arrow = this.reversible === true ? " ⇌ " : this.reversible === false ? " → " : " = ";
    this.equation = `${reactants}${arrow}${products}`;
    if (this.reversible != null) {
      const energy = (parts) => parts.reduce((sum, part) =>
        sum + molecule_bond_energy(part.molecule) * part.stoichiometric_coefficient, 0);
      this.equation += `\tΔH=${energy(this.reactants) - energy(this.products)}kJ/mol`;
    }
    if (this.conditions && Object.keys(this.conditions).length) {
      this.equation += `\nConditions:\n${Object.entries(this.conditions).map(([key, value]) => `\t${key}: ${value}\n`).join("")}`;
    }
  }

  toString() {
    return this.equation;
  }
}

export const REACTIONS = reactionData.map((item) => new Reaction(item));
export const reactionKeys = [
  "id", "name", "equation", "reaction_type", "reversible", "reactants",
  "products", "conditions", "notes", "source",
];
export const SOURCES = {
  elements: [ELEMENTS, elementKeys],
  molecules: [MOLECULES, moleculeKeys],
  reactions: [REACTIONS, reactionKeys],
};
const operators = new Set(["has", "like", "like!", "=", ">", "<", ">=", "<="]);
const queryOperations = new Set(["sort", "limit", "count"]);

export class ReturnTable extends Map {
  constructor(entries = []) {
    super(entries);
    for (const [key, value] of this) this[key] = value;
  }

  toJSON() {
    return Object.fromEntries(this);
  }

  toString() {
    const columns = [...this.keys()];
    if (!columns.length) return "";
    const count = Math.max(...columns.map((column) => this.get(column).length), 0);
    const rows = Array.from({ length: count }, (_, index) =>
      columns.map((column) => index < this.get(column).length ? String(this.get(column)[index]) : ""));
    const widths = columns.map((column, index) =>
      Math.max(String(column).length, ...rows.map((row) => row[index].length)));
    const header = columns.map((column, index) => String(column).toUpperCase().padEnd(widths[index])).join("  ").trimEnd();
    const separator = widths.map((width) => "─".repeat(width)).join("──");
    const body = rows.map((row) => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd());
    return [header, separator, ...body].join("\n");
  }
}

export function like_match(value, pattern, case_sensitive = false) {
  let expression = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\") {
      i += 1;
      if (i >= pattern.length) throw new Error("Escape character at end of pattern");
      expression += escapeRegex(pattern[i]);
    } else if (char === "*") expression += ".*";
    else if (char === "%") expression += "[0-9]*";
    else if (char === "&") expression += "[A-Za-z]*";
    else if (char === "_") expression += ".";
    else if (char === "#") expression += "[0-9]";
    else if (char === "?") expression += "[A-Za-z]";
    else expression += escapeRegex(char);
  }
  return new RegExp(`^(?:${expression})$`, case_sensitive ? "" : "i").test(value);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function format_return_table(data) {
  return new ReturnTable(Object.entries(data)).toString();
}

export function project_results(results, attributes) {
  if (attributes.length === 1) return results.map((item) => item[attributes[0]]);
  return new ReturnTable(attributes.map((attribute) => [attribute, results.map((item) => item[attribute])]));
}

export function sort_results(results, key, descending = false) {
  if (!results.every((item) => key in item)) throw new Error(`Cannot sort by \`${key}\``);
  return [...results].sort((left, right) => {
    const a = left[key];
    const b = right[key];
    if (a == null || b == null) throw new Error(`Cannot sort by \`${key}\``);
    if (typeof a === "string" && typeof b === "string") return (a < b ? -1 : a > b ? 1 : 0) * (descending ? -1 : 1);
    if (typeof a === "number" && typeof b === "number") return (a - b) * (descending ? -1 : 1);
    throw new Error(`Cannot sort by \`${key}\``);
  });
}

function tokenize(text) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  const push = () => {
    if (token !== "") tokens.push(token);
    token = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      token += char;
      escaped = false;
    } else if (char === "\\" && quote) {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      push();
    } else if (char === "(" || char === ")") {
      push();
      tokens.push(char);
    } else {
      token += char;
    }
  }
  if (quote) throw new Error("No closing quotation");
  push();
  return tokens;
}

function convertValue(value, sample) {
  if (typeof sample === "boolean") {
    if (/^true$/i.test(value)) return true;
    if (/^false$/i.test(value)) return false;
    throw new Error(`\`${value}\` is not a boolean`);
  }
  if (typeof sample === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`\`${value}\` is not a number`);
    return number;
  }
  return value;
}

function parseQuery(tokens, source, keys) {
  let index = 0;
  const fail = (message) => { throw new ChemQLError(message); };
  if (!tokens.length) fail("No conditions specified");
  if (queryOperations.has(tokens[0])) {
    let results = [...source];
    while (index < tokens.length) {
      const operation = tokens[index++];
      if (operation === "sort") {
        const key = tokens[index++];
        if (!key) fail("Expected a key after `sort`");
        if (!keys.includes(key)) fail(`There is no key \`${key}\``);
        const descending = tokens[index] === "desc";
        if (tokens[index] === "asc" || descending) index += 1;
        try { results = sort_results(results, key, descending); }
        catch (error) { fail(error.message); }
      } else if (operation === "limit") {
        const amount = tokens[index++];
        if (amount == null) fail("Expected a number after `limit`");
        if (!/^\d+$/.test(amount)) fail("`limit` requires an integer");
        results = results.slice(0, Number(amount));
      } else if (operation === "count") {
        if (index < tokens.length) fail("`count` must be the final query operation");
        return [results.length, 0];
      }
    }
    return [results, 0];
  }
  const condition = () => {
    if (tokens[index] === "(") {
      index += 1;
      const result = parseOr();
      if (tokens[index] !== ")") fail("Missing `)`");
      index += 1;
      return result;
    }
    if (index + 2 >= tokens.length) fail("Incomplete condition");
    const [key, operator, rawValue] = tokens.slice(index, index + 3);
    index += 3;
    if (!keys.includes(key)) fail(`There is no key \`${key}\``);
    if (operator === "like" || operator === "like!") {
      return (item) => typeof item[key] === "string" && like_match(item[key], rawValue, operator === "like!");
    }
    if (operator === "has") {
      return (item) => {
        const actual = item[key];
        return actual != null && (typeof actual.includes === "function") && actual.includes(rawValue);
      };
    }
    if (!["=", ">", "<", ">=", "<="].includes(operator)) fail(`Unknown operator \`${operator}\``);
    let value;
    try {
      value = convertValue(rawValue, source[0]?.[key]);
    } catch (error) {
      fail(error.message);
    }
    return (item) => {
      const actual = item[key];
      switch (operator) {
        case "=": return actual === value;
        case ">": return actual != null && actual > value;
        case "<": return actual != null && actual < value;
        case ">=": return actual != null && actual >= value;
        default: return actual != null && actual <= value;
      }
    };
  };
  const parseAnd = () => {
    let left = condition();
    while (tokens[index] === "and") {
      index += 1;
      const right = condition();
      const previous = left;
      left = (item) => previous(item) && right(item);
    }
    return left;
  };
  const parseOr = () => {
    let left = parseAnd();
    while (tokens[index] === "or") {
      index += 1;
      const right = parseAnd();
      const previous = left;
      left = (item) => previous(item) || right(item);
    }
    return left;
  };
  const filter = parseOr();
  const operationIndex = index;
  let results = source.filter(filter);
  while (index < tokens.length) {
    const operation = tokens[index++];
    if (operation === "sort") {
      const key = tokens[index++];
      if (!key) fail("Expected a key after `sort`");
      if (!keys.includes(key)) fail(`There is no key \`${key}\``);
      const descending = tokens[index] === "desc";
      if (tokens[index] === "asc" || descending) index += 1;
      try {
        results = sort_results(results, key, descending);
      } catch (error) {
        fail(error.message);
      }
    } else if (operation === "limit") {
      const amount = tokens[index++];
      if (amount == null) fail("Expected a number after `limit`");
      if (!/^\d+$/.test(amount)) fail("`limit` requires an integer");
      results = results.slice(0, Number(amount));
    } else if (operation === "count") {
      if (index < tokens.length) fail("`count` must be the final query operation");
      return [results.length, operationIndex];
    } else if (queryOperations.has(operation)) {
      fail(`Invalid query operation \`${operation}\``);
    } else {
      fail(`Unknown query operation \`${operation}\``);
    }
  }
  return [results, operationIndex];
}

function findMatching(text, start, opening, closing) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let i = start + opening.length; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === "`") quote = char;
    else if (text.startsWith(opening, i)) {
      depth += 1;
      i += opening.length - 1;
    } else if (text.startsWith(closing, i) && --depth === 0) return i;
    else if (text.startsWith(closing, i)) i += closing.length - 1;
  }
  throw new SyntaxError(`Missing \`${closing}\``);
}

const jsGlobals = { console, Math, JSON, Number, String, Boolean, Array, Object, Map, Set, RegExp };
const jsContext = vm.createContext(jsGlobals);
let currentSource = null;
export const reaction_state = { temperature_k: null, pressure_pa: null, catalysts: [] };
const sessionHistory = [];

async function executeJavaScript(code) {
  const queryValues = [];
  let rewritten = "";
  for (let index = 0; index < code.length;) {
    if (code.startsWith("{{", index)) {
      const end = findMatching(code, index, "{{", "}}");
      const value = await execute_query_text(code.slice(index + 2, end).trim());
      const key = `__chemql_query_${queryValues.length}`;
      jsGlobals[key] = value;
      queryValues.push(key);
      rewritten += key;
      index = end + 2;
    } else {
      rewritten += code[index++];
    }
  }
  try {
    return await vm.runInContext(rewritten, jsContext, { timeout: 1000 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return await vm.runInContext(`(function(){${rewritten}\n})()`, jsContext, { timeout: 1000 });
    }
    throw error;
  } finally {
    for (const key of queryValues) delete jsGlobals[key];
  }
}

async function evaluateJavaScriptExpression(code) {
  const queryValues = [];
  let rewritten = "";
  for (let index = 0; index < code.length;) {
    if (code.startsWith("{{", index)) {
      const end = findMatching(code, index, "{{", "}}");
      const value = await execute_query_text(code.slice(index + 2, end).trim());
      const name = `__chemql_query_${queryValues.length}`;
      jsGlobals[name] = value;
      queryValues.push(name);
      rewritten += name;
      index = end + 2;
    } else rewritten += code[index++];
  }
  try {
    return await vm.runInContext(`(${rewritten})`, jsContext, { timeout: 1000 });
  } finally {
    for (const name of queryValues) delete jsGlobals[name];
  }
}

async function interpolateQuery(text) {
  let output = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "[") {
      const end = findMatching(text, index, "[", "]");
      const value = await executeJavaScript(text.slice(index + 1, end));
      output += quoteToken(value == null ? "None" : String(value));
      index = end + 1;
    } else output += text[index++];
  }
  return output;
}

function quoteToken(value) {
  if (!value || /\s|["'\\]/.test(value)) return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return value;
}

function splitCommands(text) {
  const commands = [];
  let start = 0;
  let square = 0;
  let curly = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === "`") quote = char;
    else if (text.startsWith("{{", i)) { curly += 1; i += 1; }
    else if (text.startsWith("}}", i) && curly) { curly -= 1; i += 1; }
    else if (char === "[") square += 1;
    else if (char === "]" && square) square -= 1;
    else if (char === ";" && square === 0 && curly === 0) {
      commands.push(text.slice(start, i));
      start = i + 1;
    }
  }
  commands.push(text.slice(start));
  return commands;
}

function parseTemperature(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "standard") return 273.15;
  if (normalized === "room") return 298.15;
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*°?\s*([cfk])$/);
  if (!match) throw new Error("Temperature must use C, F, or K, or be `standard` or `room`");
  let temperature = Number(match[1]);
  if (match[2] === "f") temperature = (temperature - 32) * 5 / 9 + 273.15;
  else if (match[2] === "c") temperature += 273.15;
  if (temperature < 0) throw new Error("Temperature cannot be below absolute zero");
  return temperature;
}

function parsePressure(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "standard") return 100000;
  if (normalized === "room") return 101325;
  const match = normalized.match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(.*?)$/);
  const scales = { pa: 1, "n/m^2": 1, "nm^-2": 1, bar: 100000, atm: 101325 };
  const unit = match?.[2].replace(/\s+/g, "").replace("²", "^2");
  if (!match || scales[unit] == null) throw new Error("Pressure must use Pa, N/m^2, Nm^-2, bar, or atm");
  return Number(match[1]) * scales[unit];
}

function normalizeCatalysts(values) {
  const unique = new Map();
  for (const value of values) {
    const catalyst = value.trim();
    if (catalyst && !unique.has(catalyst.toLocaleLowerCase())) unique.set(catalyst.toLocaleLowerCase(), catalyst);
  }
  return [...unique.values()];
}

function formulaFor(value) {
  const found = MOLECULES.find((molecule) =>
    molecule.formula.toLowerCase() === value.toLowerCase()
    || molecule.name.toLowerCase() === value.toLowerCase()
    || molecule.iupac_name.toLowerCase() === value.toLowerCase());
  return found?.formula ?? value;
}

function parseReactants(values) {
  const counts = new Map();
  for (let i = 0; i < values.length; i += 1) {
    let value = values[i];
    let coefficient = 1;
    if (/^\d+$/.test(value)) {
      coefficient = Number(value);
      value = values[++i];
      if (!value) throw new Error("Expected a molecule after its coefficient");
    } else {
      const match = value.match(/^(\d+)(?=[A-Za-z])/);
      if (match) {
        coefficient = Number(match[1]);
        value = value.slice(match[0].length);
      }
    }
    if (coefficient <= 0 || !value) throw new Error("Reactant coefficients must be positive integers");
    const key = formulaFor(value).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + coefficient);
  }
  if (!counts.size) throw new Error("Usage: react <coefficient><molecule> ...");
  return counts;
}

function sideCounts(participants) {
  const counts = new Map();
  for (const participant of participants) {
    const key = participant.molecule.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + participant.stoichiometric_coefficient);
  }
  return counts;
}

function mapsEqual(left, right) {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function conditionsMatch(reaction) {
  const conditions = reaction.conditions ?? {};
  if (conditions.temperature_k != null && (reaction_state.temperature_k == null
      || Math.abs(reaction_state.temperature_k - conditions.temperature_k) > 5)) return false;
  if (conditions.pressure_pa != null && (reaction_state.pressure_pa == null
      || Math.abs(reaction_state.pressure_pa - conditions.pressure_pa) > Math.abs(conditions.pressure_pa) * 0.05)) return false;
  const catalysts = new Set(reaction_state.catalysts.map((item) => item.toLowerCase()));
  return (conditions.catalysts ?? []).every((item) => catalysts.has(item.toLowerCase()));
}

export let PUBCHEM_SERVICE_ERROR = false;
const PUBCHEM_BASE_URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const PUBCHEM_VIEW_URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view";

function isNetworkError(error) {
  return error.name === "TimeoutError" || error.name === "AbortError"
    || error instanceof TypeError || error instanceof SyntaxError;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "ChemQL/1.0", Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (response.status >= 500) {
        PUBCHEM_SERVICE_ERROR = true;
        if (attempt < retries) {
          await delay(500 * (attempt + 1));
          continue;
        }
        return null;
      }
      if (!response.ok) {
        PUBCHEM_SERVICE_ERROR = false;
        return null;
      }
      const data = await response.json();
      PUBCHEM_SERVICE_ERROR = false;
      return data;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      PUBCHEM_SERVICE_ERROR = true;
      if (attempt < retries) {
        await delay(500 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function fetchText(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "ChemQL/1.0", Accept: "text/html,*/*;q=0.8" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        if (response.status >= 500 && attempt < retries) {
          await delay(500 * (attempt + 1));
          continue;
        }
        return "";
      }
      return await response.text();
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      if (attempt < retries) {
        await delay(500 * (attempt + 1));
        continue;
      }
      return "";
    }
  }
  return "";
}

async function findCid(value) {
  const encoded = encodeURIComponent(value);
  const requests = [
    `${PUBCHEM_BASE_URL}/compound/name/${encoded}/cids/JSON`,
    `${PUBCHEM_BASE_URL}/compound/fastformula/${encoded}/cids/JSON`,
  ];
  for (const url of requests) {
    const data = await fetchJson(url);
    const cid = data?.IdentifierList?.CID?.[0];
    if (cid != null) return cid;
  }
  return null;
}

function walkSections(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) walkSections(item, output);
  } else if (value && typeof value === "object") {
    if (typeof value.TOCHeading === "string") output.push(value);
    for (const child of Object.values(value)) walkSections(child, output);
  }
  return output;
}

function extractText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    for (const key of ["StringWithMarkup", "String", "StringValue", "Number", "FloatValue"]) {
      if (key in value) {
        const text = extractText(value[key]);
        if (text) return text;
      }
    }
    return Object.values(value).map(extractText).filter(Boolean).join(" ");
  }
  return "";
}

function sectionValues(data, heading) {
  const section = walkSections(data).find((item) => item.TOCHeading.toLowerCase() === heading.toLowerCase());
  return (section?.Information ?? []).map((item) => extractText(item.Value).trim()).filter(Boolean);
}

function parseExperimentalTemperature(value) {
  const numbers = value.match(/[-+]?\d+(?:\.\d+)?/g)?.slice(0, 2).map(Number);
  if (!numbers?.length) return null;
  const temperature = numbers.reduce((sum, number) => sum + number, 0) / numbers.length;
  const text = value.toLowerCase();
  if (text.includes("°f") || text.includes("deg f")) return (temperature - 32) * 5 / 9;
  if (/\bk\b/.test(text)) return temperature - 273.15;
  return temperature;
}

function parseDensity(value) {
  const match = value.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0]);
  const unit = value.toLowerCase();
  if (unit.includes("kg/m3") || unit.includes("kg/m³")) return amount / 1000;
  if (unit.includes("mg/ml")) return amount / 1000;
  return amount;
}

async function fetchNistMolecule(value) {
  const url = `https://webbook.nist.gov/cgi/cbook.cgi?Name=${encodeURIComponent(value)}&Units=SI`;
  const html = await fetchText(url);
  if (!html) return null;
  const formula = html.match(/Formula\s*[:<]?[\s\n]*([A-Z][a-z]?(?:\d+)?(?:[A-Z][a-z]?(?:\d+)?)*)/i)?.[1]?.trim();
  const weight = html.match(/Molecular weight\s*[:<]?[\s\n]*([0-9]+(?:\.[0-9]+)?)/i)?.[1];
  if (!formula) return null;
  return new Molecule({
    name: value, formula, elements: [], molecular_weight: weight ? Number(weight) : 0,
    iupac_name: "", smiles: "", cid: null, melting_point: null,
    boiling_point: null, density: null, state: null,
  });
}

async function fetchExternalMolecule(value) {
  const cid = await findCid(value);
  if (cid == null) return fetchNistMolecule(value);
  const data = await fetchJson(`${PUBCHEM_BASE_URL}/compound/cid/${cid}/property/MolecularFormula,MolecularWeight,IUPACName,SMILES/JSON`);
  const properties = data?.PropertyTable?.Properties?.[0];
  if (!properties) return fetchNistMolecule(value);
  const viewData = await fetchJson(`${PUBCHEM_VIEW_URL}/data/compound/${cid}/JSON`);
  const meltingPoint = sectionValues(viewData, "Melting Point").map(parseExperimentalTemperature).find((item) => item != null) ?? null;
  const boilingPoint = sectionValues(viewData, "Boiling Point").map(parseExperimentalTemperature).find((item) => item != null) ?? null;
  const density = sectionValues(viewData, "Density").map(parseDensity).find((item) => item != null) ?? null;
  let state = null;
  if (meltingPoint != null && boilingPoint != null) {
    state = 25 < meltingPoint ? "solid" : 25 >= boilingPoint ? "gas" : "liquid";
  }
  return new Molecule({
    name: value,
    formula: properties.MolecularFormula ?? "",
    elements: [],
    molecular_weight: properties.MolecularWeight ?? 0,
    iupac_name: properties.IUPACName ?? "",
    smiles: properties.SMILES ?? "",
    cid: properties.CID ?? cid,
    melting_point: meltingPoint,
    boiling_point: boilingPoint,
    density,
    state,
  });
}

export async function fetch_pubchem_molecule(value) {
  const target = String(value ?? "").trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  if (!target) return null;
  const local = findLocalMolecule(target);
  if (local) return local;
  return fetchExternalMolecule(target);
}

function findLocalMolecule(value) {
  const normalized = String(value ?? "").trim().replace(/^(['"])(.*)\1$/, "$2").toLowerCase();
  return MOLECULES.find((item) =>
    item.name.toLowerCase() === normalized
    || item.formula.toLowerCase() === normalized
    || item.iupac_name.toLowerCase() === normalized)
    ?? MOLECULES.find((item) =>
      item.name.toLowerCase().startsWith(normalized)
      || item.formula.toLowerCase().startsWith(normalized)
      || item.iupac_name.toLowerCase().startsWith(normalized))
    ?? null;
}

async function resolveProduct(participant) {
  return findLocalMolecule(participant.molecule)
    ?? await fetch_pubchem_molecule(participant.name ?? participant.molecule)
    ?? await fetch_pubchem_molecule(participant.molecule);
}

export async function react(values) {
  let input;
  try {
    input = parseReactants(values);
  } catch (error) {
    return error.message;
  }
  const matches = [];
  for (const reaction of REACTIONS) {
    if (!conditionsMatch(reaction)) continue;
    if (mapsEqual(input, sideCounts(reaction.reactants))) matches.push([reaction, reaction.products]);
    else if (reaction.reversible === true && mapsEqual(input, sideCounts(reaction.products))) matches.push([reaction, reaction.reactants]);
  }
  if (!matches.length) return "No reaction matches those reactants and the current temperature, pressure, and catalysts";
  if (matches.length > 1) return `Multiple reactions match: ${matches.slice(0, 5).map(([reaction]) => `${reaction.name} (${reaction.id})`).join(", ")}`;
  const [reaction, products] = matches[0];
  const resolved = [];
  for (const product of products) {
    const molecule = await resolveProduct(product);
    if (!molecule) return `Could not resolve product molecule \`${product.name ?? product.molecule}\` for reaction \`${reaction.id}\``;
    resolved.push([molecule, product.stoichiometric_coefficient, product.phase ?? ""]);
  }
  if (resolved.length === 1) return resolved[0][0];
  return new ReturnTable([
    ["molecule", resolved.map(([molecule]) => molecule)],
    ["stoichiometric_coefficient", resolved.map(([, coefficient]) => coefficient)],
    ["phase", resolved.map(([, , phase]) => phase)],
  ]);
}

function currentConditions() {
  const format = (value) => value == null ? "Not Set" : String(Number(value.toPrecision(6)));
  return `Temperature: ${reaction_state.temperature_k == null ? "Not Set" : `${format(reaction_state.temperature_k)} K`}\nPressure: ${reaction_state.pressure_pa == null ? "Not Set" : `${format(reaction_state.pressure_pa)} Pa`}\nCatalysts: ${reaction_state.catalysts.length ? reaction_state.catalysts.join(", ") : "Not Set"}`;
}

function formatError(message, text = null) {
  if (text == null) return `Error: ${message}`;
  return `Error: ${message}\n${text}\n^`;
}

export async function execute(arguments_) {
  const args = [...arguments_];
  if (!args.length) return undefined;
  const command = args[0];
  if (["help", "?"].includes(command.toLowerCase())) return HELP;
  if (command.toLowerCase() === "sorry") return "\u001b[34mIt's ok, everybody makes mistakes👌\u001b[0m";
  if (command === "conditions") return args.length === 1 ? currentConditions() : "Usage: conditions";
  if (command === "set") {
    if (args.length < 2) return "Usage: set temperature|pressure|catalysts <value>";
    const setting = args[1].toLowerCase();
    const values = args.slice(2);
    if (setting === "temperature") {
      if (values.length !== 1) return "Usage: set temperature <valueC|valueF|valueK|standard|room>";
      try { reaction_state.temperature_k = parseTemperature(values[0]); }
      catch (error) { return error.message; }
      return `Temperature set to ${reaction_state.temperature_k.toFixed(2)} K`;
    }
    if (setting === "pressure") {
      if (values.length !== 1) return "Usage: set pressure <valuePa|valueN/m^2|valuebar|valueatm|standard|room>";
      try { reaction_state.pressure_pa = parsePressure(values[0]); }
      catch (error) { return error.message; }
      return `Pressure set to ${reaction_state.pressure_pa}`;
    }
    if (setting === "catalysts") {
      reaction_state.catalysts = normalizeCatalysts(values);
      return reaction_state.catalysts.length ? `Catalysts set to ${reaction_state.catalysts.join(", ")}` : "Catalysts cleared";
    }
    return `Unknown reaction setting \`${setting}\``;
  }
  if (command === "add" && args[1]?.toLowerCase() === "catalyst") {
    if (args.length < 3) return 'Usage: add catalyst "name"';
    const catalyst = args.slice(2).join(" ").trim();
    if (catalyst && !reaction_state.catalysts.some((item) => item.toLowerCase() === catalyst.toLowerCase())) reaction_state.catalysts.push(catalyst);
    return reaction_state.catalysts.length ? `Catalysts: ${reaction_state.catalysts.join(", ")}` : "Catalysts cleared";
  }
  if (command === "remove" && ["catalyst", "calatyst"].includes(args[1]?.toLowerCase())) {
    if (args.length < 3) return 'Usage: remove catalyst "name"';
    const catalyst = args.slice(2).join(" ").trim().toLowerCase();
    reaction_state.catalysts = reaction_state.catalysts.filter((item) => item.toLowerCase() !== catalyst);
    return reaction_state.catalysts.length ? `Catalysts: ${reaction_state.catalysts.join(", ")}` : "Catalysts cleared";
  }
  if (command === "react") return react(args.slice(1));
  if (command === "findel") {
    if (args.length !== 2) return "Usage: findel <name-or-symbol>";
    return execute(["search", "elements", "name", "like", args[1], "or", "symbol", "like", args[1]]);
  }
  if (command === "findmol") {
    if (args.length < 2) return "Usage: findmol <name-or-formula> [return <attribute> ...]";
    const value = args[1];
    const returnIndex = args.indexOf("return", 2);
    if (returnIndex !== -1 && (returnIndex !== 2 || returnIndex === args.length - 1)) return "Usage: findmol <name-or-formula> [return <attribute> ...]";
    if (returnIndex === -1 && args.length > 2) return "Usage: findmol <name-or-formula> [return <attribute> ...]";
    const attributes = returnIndex < 0 ? null : args.slice(returnIndex + 1);
    if (attributes?.some((attribute) => !moleculeKeys.includes(attribute))) return `There is no key \`${attributes.find((attribute) => !moleculeKeys.includes(attribute))}\``;
    let result = await execute(["search", "molecules", "name", "like", value, "or", "formula", "like", value]);
    if (result === "No matching item" || Array.isArray(result) && result.length === 0) result = await fetch_pubchem_molecule(value);
    if (result == null) return `Could not find molecule \`${value}\``;
    if (attributes) return Array.isArray(result) ? project_results(result, attributes) : new ReturnTable(attributes.map((key) => [key, [result[key]]]));
    return result;
  }
  if (command === "findre") {
    if (args.length < 2) return "Usage: findre <name-or-id> [return <attribute> ...]";
    const value = args[1];
    const returnIndex = args.indexOf("return", 2);
    if (returnIndex !== -1 && (returnIndex !== 2 || returnIndex === args.length - 1)) return "Usage: findre <name-or-id> [return <attribute> ...]";
    if (returnIndex === -1 && args.length > 2) return "Usage: findre <name-or-id> [return <attribute> ...]";
    const attributes = returnIndex < 0 ? null : args.slice(returnIndex + 1);
    const invalid = attributes?.find((attribute) => !reactionKeys.includes(attribute));
    if (invalid) return `There is no key \`${invalid}\``;
    const result = await execute(["search", "reactions", "name", "like", value, "or", "id", "like", value, "or", "equation", "like", value]);
    if (result === "No matching item") return `Could not find reaction \`${value}\``;
    return attributes ? Array.isArray(result) ? project_results(result, attributes) : new ReturnTable(attributes.map((key) => [key, [result[key]]])) : result;
  }
  if (command === "source") {
    if (args.length !== 2) return "Usage: source <source>";
    if (!(args[1] in SOURCES)) return `There is no source \`${args[1]}\``;
    currentSource = args[1];
    return `Source set to \`${args[1]}\``;
  }
  if (command === "list") {
    if (args.length !== 2 || args[1] !== "all") return "Usage: list all";
    return currentSource == null ? Object.keys(SOURCES) : [...SOURCES[currentSource][1]];
  }
  if (command === "search") {
    let index = 1;
    let mode = "all";
    if (["first", "last", "all"].includes(args[index])) mode = args[index++];
    let sourceName;
    if (args[index] in SOURCES && (currentSource == null || !operators.has(args[index + 1]))) sourceName = args[index++];
    else sourceName = currentSource;
    if (!sourceName) return "No source selected. Specify one, e.g. `search all elements atomic_mass < 100`";
    const [source, keys] = SOURCES[sourceName];
    const returnIndex = args.indexOf("return", index);
    const queryTokens = returnIndex === -1 ? args.slice(index) : args.slice(index, returnIndex);
    const attributes = returnIndex === -1 ? null : args.slice(returnIndex + 1);
    const invalid = attributes?.find((attribute) => !keys.includes(attribute));
    if (attributes && !attributes.length) return formatError("Usage: return <attribute> [<attribute> ...]");
    if (invalid) return formatError(`There is no key \`${invalid}\``);
    let results;
    try {
      [results] = parseQuery(queryTokens, source, keys);
    } catch (error) {
      if (error instanceof ChemQLError) return formatError(error.message);
      throw error;
    }
    if (typeof results === "number") {
      if (mode !== "all") return formatError("`count` cannot be combined with `first` or `last`");
      if (attributes) return formatError("`return` cannot be used with `count`");
      return results;
    }
    if (attributes) {
      const selected = mode === "first" ? results.slice(0, 1) : mode === "last" ? results.slice(-1) : results;
      return project_results(selected, attributes);
    }
    if (mode === "first") return results[0] ?? "No matching item";
    if (mode === "last") return results.at(-1) ?? "No matching item";
    if (results.length === 1) return results[0];
    return results;
  }
  if (command === "dump") {
    if (args.length !== 2) return "Usage: dump <file>";
    await writeFile(args[1], `${sessionHistory.join("\n")}\n`, "utf8");
    return `Session dumped to ${args[1]}`;
  }
  if (command === "view") {
    const file = path.resolve(packageDir, "../html/periodic_table.html");
    const [program, parameters] = process.platform === "darwin"
      ? ["open", [file]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
    await new Promise((resolve, reject) => {
      const child = spawn(program, parameters, { stdio: "ignore", detached: true });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return undefined;
  }
  if (command === "clear") {
    if (args.length !== 1) return "Usage: clear";
    process.stdout.write("\u001b[2J\u001b[H");
    return undefined;
  }
  return formatError(`Unknown command \`${command}\``);
}

export async function execute_query_text(text) {
  const query = await interpolateQuery(text.trim());
  if (!query) return undefined;
  sessionHistory.push(query);
  const args = tokenize(query);
  try {
    return await execute(args);
  } catch (error) {
    if (error instanceof ChemQLError) return formatError(error.message, query);
    throw error;
  }
}

export async function execute_query(query) {
  const value = await execute_query_text(query);
  if (typeof value === "string" || value instanceof Molecule || value instanceof Element
      || value instanceof Reaction || value instanceof Unknown) return value;
  return new Unknown(value);
}

export async function process_inline(text) {
  const line = text.trim();
  if (!line) return undefined;
  if (line.startsWith("[") && line.endsWith("]")) return executeJavaScript(line.slice(1, -1));
  if (line.startsWith("{{")) {
    const end = findMatching(line, 0, "{{", "}}");
    if (line.slice(end + 2).trim()) throw new SyntaxError("Unexpected text after query expression");
    return execute_query_text(line.slice(2, end).trim());
  }
  let result;
  for (const command of splitCommands(line)) {
    const statement = command.trim();
    if (!statement) continue;
    result = await execute_query_text(statement);
  }
  return result;
}

function isBlockHeader(line) {
  return /^\[(?:if|for|while)\b[\s\S]*\]$/.test(line.trim());
}

function findBlockEnd(lines, start) {
  let depth = 1;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (isBlockHeader(line)) depth += 1;
    else if (line === "[endblock]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new SyntaxError("Missing `[endblock]`");
}

class ChemQLControl extends Error {
  constructor(action) {
    super(action);
    this.action = action;
  }
}

async function processBlock(header, body) {
  const code = header.slice(1, -1).trim();
  if (/^if\b/.test(code)) {
    const sections = [];
    let branchHeader = code;
    let branchBody = [];
    let depth = 0;
    for (const line of body) {
      const trimmed = line.trim();
      if (isBlockHeader(trimmed)) depth += 1;
      else if (trimmed === "[endblock]") depth -= 1;
      if (depth === 0 && (/^\[(?:else\b)/.test(trimmed))) {
        sections.push([branchHeader, branchBody]);
        branchHeader = trimmed.slice(1, -1).trim();
        branchBody = [];
      } else branchBody.push(line);
    }
    sections.push([branchHeader, branchBody]);
    for (const [condition, lines] of sections) {
      if (condition === "else" || /^else\s*\{?\s*$/.test(condition)) return process_lines(lines);
      const expression = condition.replace(/^if\b/, "").replace(/^else\s+if\b/, "").trim().replace(/^\((.*)\)$/, "$1");
      if (Boolean(await evaluateJavaScriptExpression(expression))) return process_lines(lines);
    }
    return undefined;
  }
  if (/^for\b/.test(code)) {
    const match = code.match(/^for\s*\(\s*(?:(?:const|let|var)\s+)?([$\w]+)\s+of\s+([\s\S]+?)\s*\)$/);
    if (!match) throw new SyntaxError("Use `for (const item of iterable)` in a ChemQL block");
    const values = await evaluateJavaScriptExpression(match[2]);
    if (values == null || typeof values[Symbol.iterator] !== "function") {
      throw new TypeError("The value in a `for ... of` block must be iterable");
    }
    try {
      for (const value of values) {
        jsGlobals[match[1]] = value;
        try {
          await process_lines(body);
        } catch (error) {
          if (!(error instanceof ChemQLControl)) throw error;
          if (error.action === "break") break;
        }
      }
    } finally {
      delete jsGlobals[match[1]];
    }
    return undefined;
  }
  if (/^while\b/.test(code)) {
    const expression = code.replace(/^while\b/, "").trim().replace(/^\((.*)\)$/, "$1");
    let iterations = 0;
    while (Boolean(await evaluateJavaScriptExpression(expression))) {
      if (++iterations > 100000) throw new Error("JavaScript block exceeded 100000 iterations");
      try {
        await process_lines(body);
      } catch (error) {
        if (!(error instanceof ChemQLControl)) throw error;
        if (error.action === "break") break;
      }
    }
    return undefined;
  }
  return undefined;
}

export async function process_lines(lines) {
  const joined = [];
  let continued = "";
  for (const line of lines) {
    const trimmed = line.trimEnd();
    const hasContinuation = trimmed.endsWith("\\");
    continued += `${continued ? " " : ""}${hasContinuation ? trimmed.slice(0, -1).trim() : line}`;
    if (!hasContinuation) {
      joined.push(continued);
      continued = "";
    }
  }
  if (continued) joined.push(continued);
  let result;
  for (let index = 0; index < joined.length; index += 1) {
    const line = joined[index];
    let quote = null;
    let escaped = false;
    let commentStart = line.length;
    for (let cursor = 0; cursor < line.length - 1; cursor += 1) {
      const char = line[cursor];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
      } else if (char === "'" || char === '"' || char === "`") quote = char;
      else if (line.startsWith("//", cursor)) {
        commentStart = cursor;
        break;
      }
    }
    const cleaned = line.slice(0, commentStart).trim();
    if (!cleaned) continue;
    if (isBlockHeader(cleaned)) {
      const end = findBlockEnd(joined, index + 1);
      result = await processBlock(cleaned, joined.slice(index + 1, end));
      index = end;
    } else if (cleaned === "[break]" || cleaned === "[continue]") {
      throw new ChemQLControl(cleaned.slice(1, -1));
    } else if (cleaned === "[endblock]" || /^\[else\b/.test(cleaned)) {
      throw new SyntaxError(`Unexpected block clause \`${cleaned}\``);
    } else {
      result = await process_inline(cleaned);
    }
  }
  return result;
}

export function reset_session() {
  currentSource = null;
  reaction_state.temperature_k = null;
  reaction_state.pressure_pa = null;
  reaction_state.catalysts = [];
  sessionHistory.length = 0;
  for (const key of Object.keys(jsGlobals)) if (key.startsWith("__chemql_query_")) delete jsGlobals[key];
}

export const executeQueryText = execute_query_text;
export const executeQuery = execute_query;
export const formatReturnTable = format_return_table;

export const HELP = `ChemQL JavaScript

QUERYING
  search elements|molecules|reactions [conditions] [sort key [asc|desc]] [limit n] [count]
  findel <name-or-symbol>
  findmol <name-or-formula> [return <fields...>]
  findre <name-or-id> [return <fields...>]
  source <elements|molecules|reactions>
  list all

FILTERS
  =, >, <, >=, <=, like, like!, has, and, or, ( )

REACTIONS
  set temperature <valueC|valueF|valueK|standard|room>
  set pressure <valuePa|valuebar|valueatm|standard|room>
  set catalysts <names...>
  add catalyst <name> | remove catalyst <name>
  conditions
  react <coefficient><molecule> ...

JAVASCRIPT HYBRID MODE
  Use [ ... ] for JavaScript expressions/statements and {{ ... }} for queries
  embedded in JavaScript. JavaScript values persist for the current session.
  Control flow uses JavaScript syntax in [ ... ] blocks.

  Examples:
    [const threshold = 10]
    [console.log({{ search elements number = 1 }})]
    search molecules molecular_weight < [threshold] return name formula

LINE CONTINUATION
  A trailing backslash continues a command on the next line.

OPTIONS
  chemql-js -c <command>
  chemql-js -f <file>
  chemql-js --version
`;
