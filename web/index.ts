// import { Tangle, TangleState, UserId } from "./tangle/tangle_ts/src/index";
import init from "./wasm/tangleshoot";
import { set_random_name } from "./random-name"

async function main() {
  set_random_name();

  const rs = await init();
  const m = (rs as any).main as CallableFunction;
  m();
}

main();
