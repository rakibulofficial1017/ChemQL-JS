import test from "node:test";
import assert from "node:assert/strict";
import {
  Element,
  Molecule,
  REACTIONS,
  Reaction,
  ReturnTable,
  Unknown,
  balance_stoichiometry,
  execute,
  execute_query,
  execute_query_text,
  process_inline,
  process_lines,
  reaction_state,
  reset_session,
} from "../src/index.js";

test.beforeEach(() => reset_session());

test("search and comparison filters return Python-compatible record shapes", async () => {
  const hydrogen = await execute_query_text('search elements name = "Hydrogen"');
  assert.ok(hydrogen instanceof Element);
  assert.equal(hydrogen.number, 1);

  const smallMolecules = await execute_query_text("search molecules molecular_weight < 20 return name formula");
  assert.ok(smallMolecules instanceof ReturnTable);
  assert.deepEqual(smallMolecules.formula.slice(0, 4), ["H2O", "H2", "CH4", "NH3"]);
  assert.deepEqual(JSON.parse(JSON.stringify(smallMolecules)), {
    name: ["Water", "Hydrogen", "Methane", "Ammonia"],
    formula: ["H2O", "H2", "CH4", "NH3"],
  });
});

test("supports parenthesized conditions, patterns, sorting, limits, and count", async () => {
  const results = await execute_query_text('search molecules ( name like "*a*" or formula = "H2O" ) sort molecular_weight desc limit 3');
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 3);
  assert.equal(await execute_query_text("search molecules count"), 545);
});

test("lookup commands and public Unknown wrapper preserve result types", async () => {
  assert.ok(await execute(["findel", "He"]) instanceof Element);
  assert.ok(await execute(["findmol", "Water"]) instanceof Molecule);
  const reaction = await execute(["findre", "RHEA:10000", "return", "id", "name", "source"]);
  assert.ok(reaction instanceof ReturnTable);
  assert.deepEqual(reaction.id, ["RHEA:10000"]);
  assert.match(reaction.source[0], /rhea-db\.org\/rhea\/10000/);
  assert.equal(await execute_query("search molecules count").then((value) => value instanceof Unknown), true);
});

test("reactions support condition setup and product lookup", async () => {
  assert.equal(await execute(["set", "temperature", "0F"]), "Temperature set to 255.37 K");
  await execute(["set", "temperature", "723K"]);
  await execute(["set", "pressure", "20265000pa"]);
  await execute(["set", "catalysts", "iron"]);
  const product = await execute(["react", "N2", "3H2"]);
  assert.ok(product instanceof Molecule);
  assert.equal(product.formula, "NH3");
  assert.ok(REACTIONS.some((reaction) => reaction.id === "RHEA:10000"));
  assert.match(await execute(["conditions"]), /Catalysts: iron/);
});

test("balances reactions through the function API and ChemQL syntax", async () => {
  const apiReaction = balance_stoichiometry(["O2", "H2"], ["H2O"], true);
  assert.ok(apiReaction instanceof Reaction);
  assert.deepEqual(
    apiReaction.reactants.map((part) => part.stoichiometric_coefficient),
    [1, 2],
  );
  assert.deepEqual(
    apiReaction.products.map((part) => part.stoichiometric_coefficient),
    [2],
  );
  assert.equal(apiReaction.reversible, true);

  const reversible = await process_lines(["balance O2 + H2 -> H2O //reversible"]);
  assert.equal(reversible.reversible, true);
  assert.match(reversible.equation, /1 O₂ \+ 2 H₂ ⇌ 2 H₂O/);

  const irreversible = await execute_query_text(
    "balance O2 + H2 <-> H2O //irreversible",
  );
  assert.equal(irreversible.reversible, false);
  assert.match(irreversible.equation, /1 O₂ \+ 2 H₂ → 2 H₂O/);

  const grouped = balance_stoichiometry(
    ["Ca(OH)2", "H3PO4"],
    ["Ca3(PO4)2", "H2O"],
  );
  assert.deepEqual(
    [...grouped.reactants, ...grouped.products].map(
      (part) => part.stoichiometric_coefficient,
    ),
    [3, 2, 1, 6],
  );
});

test("supports JavaScript snippets and query interpolation", async () => {
  await process_inline("[globalThis.chemqlTestValue = 7]");
  assert.equal(await execute_query_text("search elements number = [globalThis.chemqlTestValue]"), await execute(["findel", "N"]));
  const queryValue = await process_inline("{{ search elements number = 1 }}");
  assert.ok(queryValue instanceof Element);
  delete globalThis.chemqlTestValue;
});

test("supports JavaScript conditional and for-of blocks", async () => {
  await process_lines([
    "[globalThis.blockResult = []]",
    "[if (true)]",
    "[for (const item of [1, 2, 3])]",
    "[globalThis.blockResult.push(item)]",
    "[endblock]",
    "[else]",
    "[globalThis.blockResult.push(0)]",
    "[endblock]",
  ]);
  assert.deepEqual(Array.from(await process_inline("[blockResult]")), [1, 2, 3]);
  await process_inline("[delete globalThis.blockResult]");
});

test("supports template literals, loop control, and line continuations", async () => {
  assert.equal(await process_inline("[`value; with ] delimiter`]"), "value; with ] delimiter");
  await process_lines([
    "[globalThis.loopResult = []]",
    "[for (const item of [1, 2, 3, 4])]",
    "[if (item === 2)]",
    "[continue]",
    "[endblock]",
    "[if (item === 4)]",
    "[break]",
    "[endblock]",
    "[globalThis.loopResult.push(item)]",
    "[endblock]",
  ]);
  assert.deepEqual(Array.from(await process_inline("[loopResult]")), [1, 3]);
  assert.equal(await process_lines(["search elements \\", "number = 1"]), await execute(["findel", "H"]));
  await process_inline("[delete globalThis.loopResult]");
});

test("query errors are returned as explicit ChemQL errors", async () => {
  assert.match(await execute_query_text("search elements imaginary = 1"), /There is no key `imaginary`/);
  assert.match(await execute_query_text("search elements name around Hydrogen"), /Unknown operator `around`/);
});
