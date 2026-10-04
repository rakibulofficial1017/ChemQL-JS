# ChemQL JavaScript

`chemql-js` is the Node.js edition of ChemQL. It ships the same element,
molecule, bond-energy, and reaction datasets as the Python package and supports
the same query language, lookup commands, result records, reaction-condition
commands, and CLI workflows. It has no runtime package dependencies.

## Requirements and installation

Node.js 18 or newer is required.

```sh
cd Language/chemql-js
npm install
npm link
```

Or use the package directly from this directory:

```sh
node bin/chemql.js -c 'search elements name = "Hydrogen"'
node bin/chemql.js -f examples/script.cql
node bin/chemql.js
```

The CLI also accepts `--version`, `--help`, and `-c <command>`. In the
interactive REPL, use `exit` to quit and `dump <file>` to write command history.
A trailing backslash continues a command onto the next line.

## JavaScript API

```js
import { execute_query_text, Element } from "chemql-js";

const hydrogen = await execute_query_text('search elements name = "Hydrogen"');
if (hydrogen instanceof Element) {
  console.log(hydrogen.symbol); // H
}
```

`execute_query_text` returns the raw ChemQL value. `execute_query` follows the
Python package's public API convention and wraps otherwise-untyped result
shapes (arrays, result tables, and counts) in `Unknown`. The package also
exports camelCase aliases `executeQueryText` and `executeQuery`.

## Query language

```text
search elements
search molecules molecular_weight < 20
search reactions reversible = true return name equation

search elements number > 10 and number < 20
search molecules name like "*water*"
search reactions name like! "Haber*"

search molecules sort molecular_weight desc limit 5
search molecules count
findel "He"
findmol "H2O"
findre "RHEA:10000" return name equation source
```

Available sources are `elements`, `molecules`, and `reactions`. Comparison
operators are `=`, `>`, `<`, `>=`, `<=`, `like`, `like!`, and `has`; conditions
support `and`, `or`, and parentheses. The `like` wildcards match Python ChemQL:
`*` any sequence, `%` zero or more digits, `&` zero or more letters, `_` any
single character, `#` one digit, and `?` one letter.

The command API also supports `source`, `list all`, `set temperature`,
`set pressure`, `set catalysts`, `add catalyst`, `remove catalyst`,
`conditions`, and `react`.

## JavaScript hybrid mode

Square brackets evaluate JavaScript in a persistent session context. Double
braces execute a ChemQL query and make its result available as a JavaScript
value:

```text
[globalThis.limit = 20]
search molecules molecular_weight < [globalThis.limit] return name formula
[console.log({{ search elements number = 1 }})]

[if (true)]
[for (const element of {{ search elements limit 3 }})]
[console.log(element.symbol)]
[endblock]
[else]
[console.log("no elements")]
[endblock]
```

As in Python ChemQL, embedded code executes in-process and should only be used
with trusted input. The JavaScript edition uses JavaScript syntax within these
blocks. Multi-line blocks use `[if (condition)]`, `[for (const item of values)]`,
or `[while (condition)]`, followed by `[endblock]`; `else` and `else if`
branches are supported in conditionals. Python snippets are not supported.

## Data and licensing

The data files are copied from the Python package's `src/chemql/data/`,
including the third-party license notices. Dataset provenance and notes are
documented in [data/README.md](data/README.md). The periodic-table HTML viewer
is included in `html/`.

## Development

```sh
npm test
```
