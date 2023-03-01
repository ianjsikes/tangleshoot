const fs = require("fs/promises");

const bindgenPath = "./web/wasm/tangleshoot.js";
async function main() {
  let bindgen = await fs.readFile(bindgenPath, "utf8");

  bindgen = `import { Tangle } from '../tangle/tangle_ts/src/index';\n${bindgen}`;
  bindgen = bindgen.replaceAll(
    `WebAssembly.instantiate`,
    `Tangle.instantiate`
  );

  bindgen = bindgen.replace(`let wasm;\n`, `let tangle;`);
  bindgen = bindgen.replaceAll(`wasm.`, `tangle._time_machine._wasm_instance.instance.exports.`);
  bindgen = bindgen.replace(
    `const { instance, module } = await load(await input, imports);`,
    `const { instance, tangle } = await load(await input, imports);`
  )
  bindgen = bindgen.replaceAll(
    `return finalizeInit(instance, module);`,
    `return finalizeInit(instance, tangle);`
  )

  bindgen = bindgen.replace(
    `function finalizeInit(instance, module)`,
    `function finalizeInit(instance, tangleInstance)`
  )
  bindgen = bindgen.replace(
    `wasm = instance.exports;`,
    `tangle = tangleInstance;`
  )
  bindgen = bindgen.replace(
    `init.__wbindgen_wasm_module = module;`,
    `init.__wbindgen_wasm_module = tangle._time_machine._wasm_instance;`
  )

  await fs.writeFile(bindgenPath, bindgen);
}

main()
  .then(() => process.exit(0))
  .catch(err => console.error(err));
