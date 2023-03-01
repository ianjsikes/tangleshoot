default: rust web

rust:
  cargo build --release --target wasm32-unknown-unknown
  wasm-bindgen --out-name tangleshoot --out-dir web/wasm --target web target/wasm32-unknown-unknown/release/tangleshoot.wasm
  node postprocess.js

web:
  cd web; npx esbuild index.ts --bundle --outfile=dist/index.js --format=esm --sourcemap
  cd web; cp ./tangle/tangle_ts/dist/rust_utilities.wasm dist/rust_utilities.wasm
  cd web; cp ./wasm/tangleshoot_bg.wasm dist/tangleshoot_bg.wasm

serve:
  npx light-server -s web/dist -o
