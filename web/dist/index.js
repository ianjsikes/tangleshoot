// tangle/tangle_ts/src/room.ts
var RoomState = /* @__PURE__ */ ((RoomState2) => {
  RoomState2[RoomState2["Joining"] = 0] = "Joining";
  RoomState2[RoomState2["Connected"] = 1] = "Connected";
  RoomState2[RoomState2["Disconnected"] = 2] = "Disconnected";
  return RoomState2;
})(RoomState || {});
var MAX_MESSAGE_SIZE = 16e3;
function compute_id_from_ip(ipAddress) {
  let uniqueNumber = 0;
  const parts = ipAddress.split(":");
  const ip = parts[0].split(".");
  const port = parseInt(parts[1], 10);
  for (let i = 0; i < 4; i++) {
    uniqueNumber += parseInt(ip[i], 10) * Math.pow(256, 3 - i);
  }
  uniqueNumber += port;
  return uniqueNumber;
}
var Room = class {
  constructor(rust_utilities) {
    this._peers_to_join = /* @__PURE__ */ new Set();
    this._current_state = 2 /* Disconnected */;
    this._peers = /* @__PURE__ */ new Map();
    this._configuration = {};
    this._outgoing_data_chunk = new Uint8Array(MAX_MESSAGE_SIZE + 5);
    // Default to 1 because 0 conflicts with the 'system' ID.
    this.my_id = 1;
    // Used for testing
    this._artificial_delay = 0;
    this._rust_utilities = rust_utilities;
  }
  static async setup(_configuration, rust_utilities) {
    const room = new Room(rust_utilities);
    await room._setup_inner(_configuration);
    return room;
  }
  message_peer_inner(peer, data) {
    if (!(peer.data_channel.readyState === "open")) {
      return;
    }
    let message_type = 3 /* SinglePart */;
    if (data.byteLength > MAX_MESSAGE_SIZE) {
      message_type = 4 /* SinglePartGzipped */;
      data = this._rust_utilities.gzip_encode(data);
    }
    if (data.byteLength > MAX_MESSAGE_SIZE) {
      this._outgoing_data_chunk[0] = 1 /* MultiPartStart */;
      new DataView(this._outgoing_data_chunk.buffer).setUint32(1, data.byteLength);
      this._outgoing_data_chunk.set(data.subarray(0, MAX_MESSAGE_SIZE), 5);
      peer.data_channel.send(this._outgoing_data_chunk);
      let data_offset = data.subarray(MAX_MESSAGE_SIZE);
      while (data_offset.byteLength > 0) {
        const length = Math.min(data_offset.byteLength, MAX_MESSAGE_SIZE);
        this._outgoing_data_chunk[0] = 2 /* MultiPartContinuation */;
        this._outgoing_data_chunk.set(data_offset.subarray(0, length), 1);
        data_offset = data_offset.subarray(length);
        peer.data_channel.send(this._outgoing_data_chunk.subarray(0, length + 1));
      }
    } else {
      this._outgoing_data_chunk[0] = message_type;
      this._outgoing_data_chunk.set(data, 1);
      peer.data_channel.send(this._outgoing_data_chunk.subarray(0, data.byteLength + 1));
    }
  }
  send_message(data, peer_id) {
    if (peer_id) {
      const peer = this._peers.get(peer_id);
      this.message_peer_inner(peer, data);
    } else {
      for (const peer of this._peers.values()) {
        if (!peer.ready) {
          continue;
        }
        this.message_peer_inner(peer, data);
      }
    }
  }
  get_lowest_latency_peer() {
    return this._peers.entries().next().value?.[0];
  }
  async _setup_inner(room_configuration) {
    var _a, _b, _c;
    this._configuration = room_configuration;
    (_a = this._configuration).server_url ?? (_a.server_url = "tangle-server.fly.dev");
    (_b = this._configuration).room_name ?? (_b.room_name = "");
    (_c = this._configuration).ice_servers ?? (_c.ice_servers = [
      {
        urls: "stun:relay.metered.ca:80"
      },
      {
        urls: "stun:stun1.l.google.com:19302"
      },
      {
        urls: "turn:relay.metered.ca:80",
        username: "acb3fd59dc274dbfd4e9ef21",
        credential: "1zeDaNt7C85INfxl"
      },
      {
        urls: "turn:relay.metered.ca:443",
        username: "acb3fd59dc274dbfd4e9ef21",
        credential: "1zeDaNt7C85INfxl"
      },
      {
        urls: "turn:relay.metered.ca:443?transport=tcp",
        username: "acb3fd59dc274dbfd4e9ef21",
        credential: "1zeDaNt7C85INfxl"
      }
    ]);
    const connect_to_server = () => {
      const server_socket = new WebSocket("wss://" + this._configuration.server_url);
      let keep_alive_interval;
      server_socket.onopen = () => {
        console.log("[room] Connection established with server");
        console.log("[room] Requesting to join room: ", this._configuration.room_name);
        server_socket.send(JSON.stringify({ "join_room": this._configuration.room_name }));
        clearInterval(keep_alive_interval);
        keep_alive_interval = setInterval(function() {
          server_socket.send("keep_alive");
        }, 1e4);
      };
      server_socket.onclose = (event) => {
        if (this._current_state != 2 /* Disconnected */) {
          clearInterval(keep_alive_interval);
          for (const peer_id of this._peers.keys()) {
            this._configuration.on_peer_left?.(peer_id, Date.now());
          }
          this._current_state = 2 /* Disconnected */;
          this._peers_to_join.clear();
          this._peers.clear();
          if (event.wasClean) {
            console.log(`[room] Server connection closed cleanly, code=${event.code} reason=${event.reason}`);
          } else {
            console.log(`[room] Server connection unexpectedly closed. code=${event.code} reason=${event.reason}`);
            console.log("event: ", event);
          }
          this._configuration.on_state_change?.(this._current_state);
        }
        setTimeout(function() {
          console.log("[room] Attempting to reconnect to server...");
          connect_to_server();
        }, 250);
      };
      server_socket.onerror = function(error) {
        console.log(`[room] Server socket error:`, error);
        server_socket.close();
      };
      server_socket.onmessage = async (event) => {
        const last_index = event.data.lastIndexOf("}");
        const json = event.data.substring(0, last_index + 1);
        const message = JSON.parse(json);
        const peer_ip = event.data.substring(last_index + 1).trim();
        const peer_id = compute_id_from_ip(peer_ip);
        if (message.room_name) {
          console.log("[room] Entering room: ", message.room_name);
          this._current_state = 0 /* Joining */;
          const peers_to_join_ids = message.peers.map(compute_id_from_ip);
          this._peers_to_join = new Set(peers_to_join_ids);
          this._configuration.on_state_change?.(this._current_state);
          for (const key of this._peers.keys()) {
            this._peers_to_join.delete(key);
          }
          this.check_if_joined();
          this.my_id = compute_id_from_ip(message.your_ip);
          console.log("[room] My id is: %d", this.my_id);
        } else if (message.join_room) {
          console.log("[room] Peer joining room: ", peer_id);
          this.make_rtc_peer_connection(peer_ip, peer_id, server_socket);
        } else if (message.offer) {
          const peer_connection = this.make_rtc_peer_connection(peer_ip, peer_id, server_socket);
          await peer_connection.setRemoteDescription(new RTCSessionDescription(message.offer));
          const answer = await peer_connection.createAnswer();
          await peer_connection.setLocalDescription(answer);
          server_socket.send(JSON.stringify({ "answer": answer, "destination": peer_ip }));
        } else if (message.answer) {
          const remoteDesc = new RTCSessionDescription(message.answer);
          await this._peers.get(peer_id)?.connection.setRemoteDescription(remoteDesc);
        } else if (message.new_ice_candidate) {
          try {
            await this._peers.get(peer_id)?.connection.addIceCandidate(message.new_ice_candidate);
          } catch (e) {
            console.error("[room] Error adding received ice candidate", e);
          }
        } else if (message.disconnected_peer_id) {
          const disconnected_peer_id = compute_id_from_ip(message.disconnected_peer_id);
          console.log("[room] Peer left: ", disconnected_peer_id);
          this.remove_peer(disconnected_peer_id, message.time);
          this._peers_to_join.delete(disconnected_peer_id);
          this.check_if_joined();
        }
      };
    };
    connect_to_server();
  }
  check_if_joined() {
    if (this._current_state == 0 /* Joining */ && this._peers_to_join.size == 0) {
      this._current_state = 1 /* Connected */;
      this._configuration.on_state_change?.(this._current_state);
    }
  }
  make_rtc_peer_connection(peer_ip, peer_id, server_socket) {
    const peer_connection = new RTCPeerConnection({ "iceServers": this._configuration.ice_servers });
    const data_channel = peer_connection.createDataChannel("sendChannel", { negotiated: true, id: 2, ordered: true });
    data_channel.binaryType = "arraybuffer";
    peer_connection.onicecandidate = (event) => {
      console.log("[room] New ice candidate: ", event.candidate);
      if (event.candidate) {
        console.log(JSON.stringify({ "new_ice_candidate": event.candidate, "destination": peer_ip }));
        server_socket.send(JSON.stringify({ "new_ice_candidate": event.candidate, "destination": peer_ip }));
      }
    };
    peer_connection.onicecandidateerror = (event) => {
      console.log("[room] Ice candidate error: ", event);
    };
    peer_connection.onnegotiationneeded = async () => {
      console.log("[room] Negotiation needed");
      const offer = await peer_connection.createOffer();
      await peer_connection.setLocalDescription(offer);
      server_socket.send(JSON.stringify({ "offer": offer, "destination": peer_ip }));
    };
    peer_connection.onsignalingstatechange = () => {
      console.log("[room] Signaling state changed: ", peer_connection.signalingState);
    };
    peer_connection.onconnectionstatechange = () => {
      console.log("[room] Connection state changed: ", peer_connection.connectionState);
    };
    peer_connection.ondatachannel = (event) => {
      peer.data_channel = event.channel;
    };
    data_channel.onopen = () => {
      this._peers_to_join.delete(peer_id);
      peer.ready = true;
      this._configuration.on_peer_joined?.(peer_id);
      this.check_if_joined();
    };
    data_channel.onmessage = (event) => {
      if (this._peers.get(peer_id)) {
        if (event.data.byteLength > 0) {
          const message_data = new Uint8Array(event.data);
          switch (message_data[0]) {
            case 3 /* SinglePart */: {
              const data = message_data.subarray(1);
              setTimeout(() => {
                this._configuration.on_message?.(peer_id, data);
              }, this._artificial_delay);
              break;
            }
            case 4 /* SinglePartGzipped */: {
              const data = this._rust_utilities.gzip_decode(message_data.subarray(1));
              setTimeout(() => {
                this._configuration.on_message?.(peer_id, data);
              }, this._artificial_delay);
              break;
            }
            case 1 /* MultiPartStart */: {
              const data = new DataView(message_data.buffer, 1);
              const length = data.getUint32(0);
              peer.latest_message_data = new Uint8Array(length);
              this.multipart_data_received(peer, message_data.subarray(5));
              break;
            }
            case 2 /* MultiPartContinuation */: {
              this.multipart_data_received(peer, message_data.subarray(1));
            }
          }
        }
      } else {
        console.error("DISCARDING MESSAGE FROM PEER: ", event.data);
      }
    };
    const peer = { id: peer_id, connection: peer_connection, data_channel, ready: false, latest_message_data: new Uint8Array(0), latest_message_offset: 0 };
    this._peers.set(peer_id, peer);
    return peer_connection;
  }
  multipart_data_received(peer, data) {
    peer.latest_message_data.set(data, peer.latest_message_offset);
    peer.latest_message_offset += data.byteLength;
    if (peer.latest_message_offset == peer.latest_message_data.length) {
      let data2 = peer.latest_message_data;
      data2 = this._rust_utilities.gzip_decode(data2);
      setTimeout(() => {
        this._configuration.on_message?.(peer.id, data2);
      }, this._artificial_delay);
      peer.latest_message_offset = 0;
      peer.latest_message_data = new Uint8Array(0);
    }
  }
  remove_peer(peer_id, time) {
    const peer = this._peers.get(peer_id);
    if (peer) {
      peer.connection.close();
      this._peers.delete(peer_id);
      this._configuration.on_peer_left?.(peer_id, time);
    }
  }
  disconnect() {
    this._server_socket?.close();
  }
};

// tangle/tangle_ts/src/message_encoding.ts
var text_encoder = new TextEncoder();
var text_decoder = new TextDecoder();
var MessageWriterReader = class {
  constructor(output) {
    this.offset = 0;
    this.output = output;
    this.data_view = new DataView(output.buffer, output.byteOffset);
  }
  get_result_array() {
    return this.output.subarray(0, this.offset);
  }
  write_raw_bytes(bytes) {
    this.output.subarray(this.offset).set(bytes);
    this.offset += bytes.length;
  }
  read_remaining_raw_bytes() {
    return this.output.subarray(this.offset);
  }
  read_fixed_raw_bytes(length) {
    const result = this.output.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  write_string(string) {
    const length = text_encoder.encodeInto(string, this.output.subarray(this.offset + 4)).written;
    this.data_view.setUint32(this.offset, length);
    this.offset += length + 4;
  }
  read_string() {
    const length = this.read_u32();
    const result = text_decoder.decode(this.output.subarray(this.offset, this.offset + length));
    this.offset += length;
    return result;
  }
  write_u8(v) {
    this.data_view.setUint8(this.offset, v);
    this.offset += 1;
  }
  write_u16(v) {
    this.data_view.setUint16(this.offset, v);
    this.offset += 2;
  }
  write_u32(v) {
    this.data_view.setUint32(this.offset, v);
    this.offset += 4;
  }
  write_f32(v) {
    this.data_view.setFloat32(this.offset, v);
    this.offset += 4;
  }
  read_u8() {
    const result = this.data_view.getUint8(this.offset);
    this.offset += 1;
    return result;
  }
  read_u16() {
    const result = this.data_view.getUint16(this.offset);
    this.offset += 2;
    return result;
  }
  read_u32() {
    const result = this.data_view.getUint32(this.offset);
    this.offset += 4;
    return result;
  }
  read_f32() {
    const result = this.data_view.getFloat32(this.offset);
    this.offset += 4;
    return result;
  }
  read_f64() {
    const result = this.data_view.getFloat64(this.offset);
    this.offset += 8;
    return result;
  }
  write_f64(v) {
    this.data_view.setFloat64(this.offset, v);
    this.offset += 8;
  }
  read_i64() {
    const result = this.data_view.getBigInt64(this.offset);
    this.offset += 8;
    return result;
  }
  write_i64(v) {
    this.data_view.setBigInt64(this.offset, v);
    this.offset += 8;
  }
  write_tagged_number(number) {
    if (typeof number == "bigint") {
      this.write_u8(1 /* I64 */);
      this.write_i64(number);
    } else {
      this.write_u8(0 /* F64 */);
      this.write_f64(number);
    }
  }
  read_tagged_number() {
    const tag_byte = this.read_u8();
    if (tag_byte === 0 /* F64 */) {
      return this.read_f64();
    } else {
      return this.read_i64();
    }
  }
  write_wasm_snapshot(snapshot) {
    this.write_time_stamp(snapshot.time_stamp);
    const globals_count = snapshot.globals.length;
    this.write_u16(globals_count);
    for (const value of snapshot.globals) {
      this.write_u32(value[0]);
      this.write_tagged_number(value[1]);
    }
    this.write_u32(snapshot.memory.byteLength);
    this.write_raw_bytes(snapshot.memory);
  }
  read_wasm_snapshot() {
    const time_stamp = this.read_time_stamp();
    const mutable_globals_length = this.read_u16();
    const globals = [];
    for (let i = 0; i < mutable_globals_length; i++) {
      const index = this.read_u32();
      const value = this.read_tagged_number();
      globals.push([index, value]);
    }
    const bytes_length = this.read_u32();
    const memory = this.read_fixed_raw_bytes(bytes_length);
    return {
      memory,
      globals,
      time_stamp
    };
  }
  write_time_stamp(time_stamp) {
    this.write_f64(time_stamp.time);
    this.write_f64(time_stamp.player_id);
  }
  read_time_stamp() {
    return {
      time: this.read_f64(),
      player_id: this.read_f64()
    };
  }
};

// tangle/tangle_ts/src/rust_utilities.ts
var decoder = new TextDecoder();
var RustUtilities = class {
  constructor(rust_utilities) {
    this._rust_utilities = rust_utilities;
  }
  static async setup() {
    const imports2 = {
      env: {
        external_log: function(pointer, length) {
          const memory = rust_utilities.instance.exports.memory;
          const message_data = new Uint8Array(memory.buffer, pointer, length);
          const decoded_string = decoder.decode(new Uint8Array(message_data));
          console.log(decoded_string);
        },
        external_error: function(pointer, length) {
          const memory = rust_utilities.instance.exports.memory;
          const message_data = new Uint8Array(memory.buffer, pointer, length);
          const decoded_string = decoder.decode(new Uint8Array(message_data));
          console.error(decoded_string);
        }
      }
    };
    console.log(import.meta);
    const url = new URL(import.meta.url);
    const url_without_file = url.origin + url.pathname.substring(0, url.pathname.lastIndexOf("/") + 1);
    const final_url = new URL("rust_utilities.wasm", url_without_file);
    const binary = await fetch(final_url).then((response) => response.arrayBuffer());
    const rust_utilities = await WebAssembly.instantiate(binary, imports2);
    return new RustUtilities(rust_utilities);
  }
  gzip_decode(data_to_decode) {
    const memory = this._rust_utilities.instance.exports.memory;
    const instance = this._rust_utilities.instance.exports;
    const pointer = instance.reserve_space(data_to_decode.byteLength);
    const destination = new Uint8Array(memory.buffer, pointer, data_to_decode.byteLength);
    destination.set(data_to_decode);
    instance.gzip_decode();
    const result_pointer = new Uint32Array(memory.buffer, pointer, 2);
    const result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
    return new Uint8Array(result_data);
  }
  // TODO: These are just helpers and aren't that related to the rest of the code in this:
  gzip_encode(data_to_compress) {
    const memory = this._rust_utilities.instance.exports.memory;
    const exports = this._rust_utilities.instance.exports;
    const pointer = exports.reserve_space(data_to_compress.byteLength);
    const destination = new Uint8Array(memory.buffer, pointer, data_to_compress.byteLength);
    destination.set(new Uint8Array(data_to_compress));
    exports.gzip_encode();
    const result_pointer = new Uint32Array(memory.buffer, pointer, 2);
    const result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
    return result_data;
  }
  hash_data(...data_to_hash) {
    let byteLength = 0;
    for (const data of data_to_hash) {
      byteLength += data.byteLength;
    }
    const memory = this._rust_utilities.instance.exports.memory;
    const instance = this._rust_utilities.instance.exports;
    const pointer = instance.reserve_space(byteLength);
    let offset = 0;
    for (const data of data_to_hash) {
      const destination = new Uint8Array(memory.buffer, pointer + offset, data.byteLength);
      destination.set(new Uint8Array(data));
      offset += data.byteLength;
    }
    instance.xxh3_128_bit_hash();
    const hashed_result = new Uint8Array(new Uint8Array(memory.buffer, pointer, 16));
    return hashed_result;
  }
  hash_snapshot(wasm_snapshot) {
    const header = new Uint8Array(2 + wasm_snapshot.globals.length * (4 + 9));
    const writer = new MessageWriterReader(header);
    const globals_count = wasm_snapshot.globals.length;
    writer.write_u16(globals_count);
    for (const value of wasm_snapshot.globals) {
      writer.write_u32(value[0]);
      writer.write_tagged_number(value[1]);
    }
    const result = this.hash_data(writer.get_result_array(), new Uint8Array(wasm_snapshot.memory.buffer));
    return result;
  }
  process_binary(wasm_binary, export_globals, track_changes) {
    if (!(export_globals || track_changes)) {
      return wasm_binary;
    }
    const length = wasm_binary.byteLength;
    const pointer = this._rust_utilities.instance.exports.reserve_space(length);
    const memory = this._rust_utilities.instance.exports.memory;
    const data_location = new Uint8Array(memory.buffer, pointer, length);
    data_location.set(new Uint8Array(wasm_binary));
    this._rust_utilities.instance.exports.prepare_wasm(export_globals, track_changes);
    const output_ptr = this._rust_utilities.instance.exports.get_output_ptr();
    const output_len = this._rust_utilities.instance.exports.get_output_len();
    const output_wasm = new Uint8Array(memory.buffer, output_ptr, output_len);
    return output_wasm;
  }
};

// tangle/tangle_ts/src/time_machine.ts
var WASM_PAGE_SIZE = 65536;
function time_stamp_compare(a, b) {
  let v = Math.sign(a.time - b.time);
  if (v != 0) {
    return v;
  }
  v = Math.sign(a.player_id - b.player_id);
  if (v != 0) {
    return v;
  }
  return 0;
}
var decoder2 = new TextDecoder();
var action_log = "";
var debug_mode = false;
var TimeMachine = class {
  constructor(wasm_instance, rust_utilities) {
    this._current_simulation_time = { time: 0, player_id: 0 };
    this._fixed_update_time = 0;
    this._target_time = 0;
    this._events = [];
    this._snapshots = [];
    this._imports = {};
    this._global_indices = [];
    this._exports = [];
    this._export_keys = [];
    // To facilitate simpler storage, serialization, and networking function calls
    // are associated with an index instead of a string.
    this._function_name_to_index = /* @__PURE__ */ new Map();
    this._wasm_instance = wasm_instance;
    this._exports = Object.values(wasm_instance.instance.exports);
    this._export_keys = Object.keys(wasm_instance.instance.exports);
    this.rust_utilities = rust_utilities;
  }
  static async setup(wasm_binary, imports2, fixed_update_interval) {
    var _a, _b, _c;
    const rust_utilities = await RustUtilities.setup();
    {
      imports2.env ?? (imports2.env = {});
      (_a = imports2.env).abort ?? (_a.abort = () => {
        console.log("Ignoring call to abort");
      });
      (_b = imports2.env).seed ?? (_b.seed = () => {
        return 14;
      });
    }
    let external_log = () => {
      console.log("Not implemented");
    };
    (_c = imports2.env).external_log ?? (_c.external_log = (a, b) => external_log(a, b));
    wasm_binary = rust_utilities.process_binary(wasm_binary, true, false);
    const wasm_instance = await WebAssembly.instantiate(wasm_binary, imports2);
    const time_machine = new TimeMachine(wasm_instance, rust_utilities);
    console.log("[tangle] Heap size: ", wasm_instance.instance.exports.memory.buffer.byteLength);
    external_log = (pointer, length) => {
      const memory = time_machine._wasm_instance.instance.exports.memory;
      const message_data = new Uint8Array(memory.buffer, pointer, length);
      const decoded_string = decoder2.decode(new Uint8Array(message_data));
      console.log(decoded_string);
    };
    time_machine._imports = imports2;
    time_machine._fixed_update_interval = fixed_update_interval;
    let j = 0;
    for (const key of Object.keys(wasm_instance.instance.exports)) {
      if (key.slice(0, 3) == "wg_") {
        time_machine._global_indices.push(j);
      }
      time_machine._function_name_to_index.set(key, j);
      if (key == "fixed_update") {
        time_machine._fixed_update_index = j;
      }
      j += 1;
    }
    if (time_machine._fixed_update_index !== void 0) {
      time_machine._fixed_update_interval ?? (time_machine._fixed_update_interval = 1e3 / 60);
    } else {
      time_machine._fixed_update_interval = void 0;
    }
    time_machine._snapshots = [time_machine._get_wasm_snapshot()];
    console.log("\u{1F680}\u23F3 Time Machine Activated \u23F3\u{1F680}");
    return time_machine;
  }
  read_memory(address, length) {
    return new Uint8Array(new Uint8Array(this._wasm_instance.instance.exports.memory.buffer, address, length));
  }
  read_string(address, length) {
    const message_data = this.read_memory(address, length);
    const decoded_string = decoder2.decode(new Uint8Array(message_data));
    return decoded_string;
  }
  get_function_export_index(function_name) {
    return this._function_name_to_index.get(function_name);
  }
  get_function_name(function_index) {
    return this._export_keys[function_index];
  }
  /// Returns the function call of this instance.
  async call_with_time_stamp(function_export_index, args, time_stamp) {
    if (time_stamp_compare(time_stamp, this._snapshots[0].time_stamp) == -1) {
      console.error("[tangle error] Attempting to rollback to before earliest safe time");
      console.error("Event Time: ", time_stamp);
      console.error("Earlieset Snapshot Time: ", this._snapshots[0].time_stamp);
      throw new Error("[tangle error] Attempting to rollback to before earliest safe time");
    }
    this._progress_recurring_function_calls(time_stamp.time);
    let i = this._events.length - 1;
    outer_loop:
      for (; i >= 0; i -= 1) {
        switch (time_stamp_compare(this._events[i].time_stamp, time_stamp)) {
          case -1:
            break outer_loop;
          case 1:
            break;
          case 0: {
            const event2 = this._events[i];
            if (function_export_index != event2.function_export_index || !array_equals(args, event2.args)) {
              console.error("[tangle warning] Attempted to call a function with a duplicate time stamp.");
              console.log("Event Time: ", time_stamp);
              console.log("Function name: ", this.get_function_name(function_export_index));
            }
            return;
          }
        }
      }
    if (time_stamp_compare(time_stamp, this._current_simulation_time) == -1) {
      if (this._need_to_rollback_to_time === void 0 || time_stamp_compare(time_stamp, this._need_to_rollback_to_time) == -1) {
        this._need_to_rollback_to_time = time_stamp;
      }
    }
    const event = {
      function_export_index,
      args,
      time_stamp
    };
    this._events.splice(i + 1, 0, event);
    if (debug_mode) {
      action_log += `Inserting call ${i + 1} ${event.time_stamp.time} ${event.time_stamp.player_id} ${this.get_function_name(event.function_export_index)}
`;
    }
  }
  /// Call a function but ensure its results do not persist and cannot cause a desync.
  /// This can be used for things like drawing or querying from the Wasm
  async call_and_revert(function_export_index, args) {
    const f = this._exports[function_export_index];
    if (f) {
      const snapshot = this._get_wasm_snapshot();
      f(...args);
      await this._apply_snapshot(snapshot);
    }
  }
  _progress_recurring_function_calls(target_time) {
    if (this._fixed_update_interval !== void 0 && this._fixed_update_index !== void 0) {
      while (target_time > this._fixed_update_time) {
        this.call_with_time_stamp(this._fixed_update_index, [], { time: this._fixed_update_time, player_id: 0 });
        this._fixed_update_time += this._fixed_update_interval;
      }
    }
  }
  target_time() {
    return this._target_time;
  }
  // This is used in scenarios where a peer falls too far behind in a simulation. 
  // This lets them have normal visuals until they resync.
  set_target_time(time) {
    this._target_time = time;
  }
  current_simulation_time() {
    return this._current_simulation_time.time;
  }
  /// This lets the simulation run further into the future.
  /// No functions are actually called yet, that's the responsibility of `step`
  progress_time(time) {
    this._target_time += time;
    this._progress_recurring_function_calls(this._target_time);
  }
  /// Simulates one function step forward and returns if there's more work to do.
  /// This gives the calling context an opportunity to manage how much CPU-time is consumed.
  /// Call this is in a loop and if it returns true continue. 
  step() {
    if (this._need_to_rollback_to_time !== void 0) {
      if (debug_mode) {
        action_log += `Target rollback time: ${this._need_to_rollback_to_time.time} ${this._need_to_rollback_to_time.player_id}
`;
      }
      let i2 = this._snapshots.length - 1;
      for (; i2 >= 0; --i2) {
        if (time_stamp_compare(this._need_to_rollback_to_time, this._snapshots[i2].time_stamp) != -1) {
          break;
        }
      }
      const snap_shot = this._snapshots[i2];
      this._apply_snapshot(snap_shot);
      this._snapshots.splice(i2, this._snapshots.length - i2);
      if (debug_mode) {
        action_log += `Rolling back to: ${snap_shot.time_stamp.time} ${snap_shot.time_stamp.player_id}
`;
      }
      this._current_simulation_time = snap_shot.time_stamp;
      this._need_to_rollback_to_time = void 0;
    }
    let i = this._events.length - 1;
    for (; i >= 0; --i) {
      if (time_stamp_compare(this._events[i].time_stamp, this._current_simulation_time) != 1) {
        break;
      }
    }
    i += 1;
    const function_call = this._events[i];
    if (function_call !== void 0 && function_call.time_stamp.time <= this._target_time) {
      const f = this._exports[function_call.function_export_index];
      f(...function_call.args);
      if (debug_mode) {
        function_call.hash = this.hash_wasm_state();
      }
      if (action_log) {
        const event = function_call;
        action_log += `i ${event.time_stamp.time} ${event.time_stamp.player_id} ${this.get_function_name(event.function_export_index)} ${event.hash}
`;
      }
      this._current_simulation_time = function_call.time_stamp;
      return true;
    }
    return false;
  }
  // Take a snapshot. This provides a point in time to rollback to.
  // This should be called after significant computation has been performed.
  take_snapshot() {
    let i = this._events.length - 1;
    for (; i >= 0; --i) {
      const compare = time_stamp_compare(this._events[i].time_stamp, this._current_simulation_time);
      if (compare == -1) {
        return;
      }
      if (compare == 0) {
        this._snapshots.push(this._get_wasm_snapshot());
        return;
      }
    }
  }
  remove_history_before(time) {
    if (debug_mode) {
      return;
    }
    let i = 0;
    for (; i < this._snapshots.length - 1; ++i) {
      if (this._snapshots[i].time_stamp.time >= time) {
        break;
      }
    }
    i -= 1;
    this._snapshots.splice(0, i);
    let j = 0;
    for (; j < this._events.length; ++j) {
      if (time_stamp_compare(this._events[j].time_stamp, this._snapshots[0].time_stamp) != -1) {
        break;
      }
    }
    j -= 1;
    this._events.splice(0, j);
  }
  // `deep` specifies if the memory is deep-copied for this snapshot. 
  _get_wasm_snapshot(deep = true) {
    const globals = [];
    const export_values = Object.values(this._wasm_instance.instance.exports);
    for (const index of this._global_indices) {
      globals.push([index, export_values[index].value]);
    }
    let memory = new Uint8Array(this._wasm_instance.instance.exports.memory.buffer);
    if (deep) {
      memory = new Uint8Array(memory);
    }
    return {
      // This nested Uint8Array constructor creates a deep copy.
      memory,
      globals,
      time_stamp: this._current_simulation_time
    };
  }
  async _apply_snapshot(snapshot) {
    this._assign_memory(snapshot.memory);
    const values = Object.values(this._wasm_instance.instance.exports);
    for (let j = 0; j < snapshot.globals.length; j++) {
      values[snapshot.globals[j][0]].value = snapshot.globals[j][1];
    }
  }
  async _assign_memory(new_memory_data) {
    const mem = this._wasm_instance?.instance.exports.memory;
    let page_diff = (new_memory_data.byteLength - mem.buffer.byteLength) / WASM_PAGE_SIZE;
    if (page_diff < 0) {
      const old_instance = this._wasm_instance.instance;
      this._wasm_instance.instance = await WebAssembly.instantiate(this._wasm_instance.module, this._imports);
      page_diff = (new_memory_data.byteLength - (this._wasm_instance?.instance.exports.memory).buffer.byteLength) / WASM_PAGE_SIZE;
      for (const [key, v] of Object.entries(old_instance.exports)) {
        if (key.slice(0, 3) == "wg_") {
          this._wasm_instance.instance.exports[key].value = v;
        }
      }
    }
    const old_memory = this._wasm_instance?.instance.exports.memory;
    if (page_diff > 0) {
      old_memory.grow(page_diff);
    }
    new Uint8Array(old_memory.buffer).set(new_memory_data);
  }
  encode(first_byte) {
    console.log("[time-machine] Encoding with hash: ", this.hash_wasm_state());
    const snapshot = this._snapshots[0];
    let size = 1 + 8 * 4 + 4 + (4 + 8 + 8 + 1) * this._events.length;
    for (const event of this._events) {
      size += event.args.length * 8;
    }
    size += 8 + 8 + 2 + (4 + 9) * snapshot.globals.length;
    size += 4 + snapshot.memory.buffer.byteLength;
    const writer = new MessageWriterReader(new Uint8Array(size));
    writer.write_u8(first_byte);
    writer.write_f64(this._fixed_update_time);
    writer.write_f64(this._target_time);
    writer.write_time_stamp(snapshot.time_stamp);
    writer.write_u32(this._events.length);
    for (const event of this._events) {
      writer.write_u32(event.function_export_index);
      writer.write_time_stamp(event.time_stamp);
      writer.write_u8(event.args.length);
      for (const arg of event.args) {
        writer.write_f64(arg);
      }
    }
    writer.write_wasm_snapshot(snapshot);
    console.log("[time-machine] Hash of sent snapshot: ", this.rust_utilities.hash_snapshot(snapshot));
    return writer.get_result_array();
  }
  decode_and_apply(reader) {
    this._fixed_update_time = reader.read_f64();
    this._target_time = reader.read_f64();
    this._current_simulation_time = reader.read_time_stamp();
    const events_length = reader.read_u32();
    this._events = new Array(events_length);
    let last_time_stamp = {
      time: -1,
      player_id: 0
    };
    for (let i = 0; i < events_length; ++i) {
      const function_export_index = reader.read_u32();
      const time_stamp = reader.read_time_stamp();
      const args_length = reader.read_u8();
      const args = new Array(args_length);
      for (let j = 0; j < args_length; ++j) {
        args[j] = reader.read_f64();
      }
      this._events[i] = {
        function_export_index,
        time_stamp,
        args
      };
      if (!(time_stamp_compare(last_time_stamp, time_stamp) == -1)) {
        console.error("[time-machine] Error: Incoming time stamps out of order");
      }
      last_time_stamp = time_stamp;
    }
    const wasm_snapshot = reader.read_wasm_snapshot();
    this._apply_snapshot(wasm_snapshot);
    this._snapshots = [wasm_snapshot];
    console.log("[time-machine] Decoded with hash: ", this.hash_wasm_state());
  }
  hash_wasm_state() {
    return this.rust_utilities.hash_snapshot(this._get_wasm_snapshot(false));
  }
  print_history() {
    let history = "";
    let previous_time_stamp = { time: -1, player_id: 0 };
    for (const event of this._events) {
      if (time_stamp_compare(previous_time_stamp, event.time_stamp) != -1) {
        history += "ERROR: OUT OF ORDER TIMESTAMPS\n";
      }
      history += `${event.time_stamp.time} ${event.time_stamp.player_id} ${this.get_function_name(event.function_export_index)} ${event.hash}
`;
      previous_time_stamp = event.time_stamp;
    }
    console.log(action_log);
    console.log(history);
  }
};
function array_equals(a, b) {
  return a.length === b.length && a.every((val, index) => val === b[index]);
}

// tangle/tangle_ts/src/tangle.ts
var TangleState = /* @__PURE__ */ ((TangleState2) => {
  TangleState2[TangleState2["Disconnected"] = 0] = "Disconnected";
  TangleState2[TangleState2["Connected"] = 1] = "Connected";
  TangleState2[TangleState2["RequestingHeap"] = 2] = "RequestingHeap";
  return TangleState2;
})(TangleState || {});
var UserIdType = class {
};
var UserId = new UserIdType();
var ROUND_TRIP_TIME_ROLLING_AVERAGE_ALPHA = 0.9;
var Tangle = class {
  constructor(time_machine) {
    this._buffered_messages = [];
    this._peer_data = /* @__PURE__ */ new Map();
    this._tangle_state = 0 /* Disconnected */;
    this._current_program_binary = new Uint8Array();
    this._block_reentrancy = false;
    this._enqueued_inner_calls = [];
    this._configuration = {};
    this._outgoing_message_buffer = new Uint8Array(500);
    this._message_time_offset = 0;
    this._last_sent_message = 0;
    this._in_call_that_will_be_reverted = false;
    this._time_machine = time_machine;
    this._rust_utilities = time_machine.rust_utilities;
  }
  // private _debug_enabled = true;
  static async instantiate(source, importObject, tangle_configuration) {
    tangle_configuration ?? (tangle_configuration = {});
    tangle_configuration.accept_new_programs ?? (tangle_configuration.accept_new_programs = false);
    const wasm_binary = new Uint8Array(source);
    importObject ?? (importObject = {});
    const time_machine = await TimeMachine.setup(wasm_binary, importObject, tangle_configuration.fixed_update_interval);
    const tangle2 = new Tangle(time_machine);
    tangle2._configuration = tangle_configuration;
    const exports = await tangle2.setup_inner(tangle_configuration.room_name, wasm_binary);
    return {
      instance: {
        exports
      },
      tangle: tangle2
    };
  }
  static async instantiateStreaming(source, importObject, tangle_configuration) {
    source = await source;
    const binary = await source.arrayBuffer();
    return Tangle.instantiate(new Uint8Array(binary), importObject, tangle_configuration);
  }
  _change_state(state) {
    if (this._tangle_state != state) {
      if (state == 1 /* Connected */) {
        console.log("\u{1F331} Tangle State: ", TangleState[state]);
        console.log("Learn more about Tangle at https://tanglesync.com");
        this._last_performance_now = performance.now();
      }
      this._tangle_state = state;
      this._configuration.on_state_change_callback?.(state, this);
    }
    this._tangle_state = state;
  }
  async setup_inner(room_name, wasm_binary) {
    room_name ?? (room_name = document.location.href);
    const hash = this._rust_utilities.hash_data(wasm_binary);
    room_name += hash.join("");
    const room_configuration = {
      server_url: this._configuration.room_server,
      ice_servers: this._configuration.ice_servers,
      room_name,
      on_peer_joined: (peer_id) => {
        this._peer_data.set(peer_id, {
          last_received_message: 0,
          round_trip_time: 0,
          estimated_current_time_measurement: 0,
          estimated_current_time: void 0
        });
        this._room.send_message(this._encode_ping_message(), peer_id);
      },
      on_peer_left: (peer_id) => {
        this._run_inner_function(async () => {
          this._peer_data.delete(peer_id);
          let closest_peer = this._room.my_id;
          let peer_distance = this._room.my_id - peer_id;
          for (const peer of this._peer_data.keys()) {
            const diff = peer - peer_id;
            if (diff != 0 && diff < peer_distance) {
              closest_peer = peer;
              peer_distance = diff;
            }
          }
          console.log("[tangle] calling 'peer_left'");
          if (closest_peer == this._room.my_id) {
            this.call("peer_left", peer_id);
          }
        });
      },
      on_state_change: (state) => {
        this._run_inner_function(async () => {
          console.log("[tangle] Room state changed: ", RoomState[state]);
          switch (state) {
            case 1 /* Connected */: {
              this._request_heap();
              if (this._peer_data.size == 0) {
                this._change_state(1 /* Connected */);
              }
              break;
            }
            case 2 /* Disconnected */: {
              this._change_state(0 /* Disconnected */);
              break;
            }
            case 0 /* Joining */: {
              this._change_state(0 /* Disconnected */);
              break;
            }
          }
        });
      },
      on_message: async (peer_id, message) => {
        const peer_connected_already = this._peer_data.get(peer_id);
        this._run_inner_function(async () => {
          const peer = this._peer_data.get(peer_id);
          if (!peer) {
            console.log("[tangle] Rejected message from unconnected peer: ", peer_id);
            return;
          }
          const message_type = message[0];
          const message_data = message.subarray(1);
          switch (message_type) {
            case 1 /* TimeProgressed */: {
              const time = this._decode_time_progressed_message(message_data);
              peer.last_received_message = time;
              break;
            }
            case 0 /* WasmCall */: {
              const m = this._decode_wasm_call_message(message_data);
              peer.last_received_message = m.time;
              const time_stamp = {
                time: m.time,
                player_id: peer_id
              };
              if (this._tangle_state == 2 /* RequestingHeap */) {
                this._buffered_messages.push({
                  function_export_index: m.function_index,
                  time_stamp,
                  args: m.args
                });
              } else {
                console.log("[tangle] Remote Wasm call: ", this._time_machine.get_function_name(m.function_index));
                await this._time_machine.call_with_time_stamp(m.function_index, m.args, time_stamp);
                if (!this._time_machine._fixed_update_interval) {
                  this.progress_time();
                }
              }
              break;
            }
            case 2 /* RequestState */: {
              const heap_message = this._time_machine.encode(4 /* SetHeap */);
              this._room.send_message(heap_message);
              break;
            }
            case 4 /* SetHeap */: {
              if (this._tangle_state != 1 /* Connected */) {
                console.log("[tangle] Applying TimeMachine state from peer");
                const round_trip_time = peer.round_trip_time;
                console.log("[tangle] Approximate round trip offset: ", round_trip_time / 2);
                this._time_machine.decode_and_apply(new MessageWriterReader(message_data));
                for (const m of this._buffered_messages) {
                  await this._time_machine.call_with_time_stamp(m.function_export_index, m.args, m.time_stamp);
                }
                this._buffered_messages = [];
                this._time_machine.progress_time(round_trip_time / 2);
                this._change_state(1 /* Connected */);
              }
              break;
            }
            case 5 /* Ping */: {
              const writer = new MessageWriterReader(this._outgoing_message_buffer);
              writer.write_u8(6 /* Pong */);
              writer.write_raw_bytes(message_data);
              writer.write_f64(this._average_current_time(performance.now()));
              this._room.send_message(writer.get_result_array(), peer_id);
              break;
            }
            case 6 /* Pong */: {
              const { time_sent, current_time } = this._decode_pong_message(message_data);
              const new_round_trip_time = Date.now() - time_sent;
              if (peer.round_trip_time == 0) {
                peer.round_trip_time = new_round_trip_time;
              } else {
                peer.round_trip_time = peer.round_trip_time * ROUND_TRIP_TIME_ROLLING_AVERAGE_ALPHA + (1 - ROUND_TRIP_TIME_ROLLING_AVERAGE_ALPHA) * new_round_trip_time;
              }
              peer.estimated_current_time = current_time + peer.round_trip_time / 2;
              peer.estimated_current_time_measurement = performance.now();
              break;
            }
          }
        }, !peer_connected_already);
      }
    };
    this._room = await Room.setup(room_configuration, this._rust_utilities);
    this._current_program_binary = wasm_binary;
    const export_object = {};
    for (const key of Object.keys(this._time_machine._wasm_instance.instance.exports)) {
      const e = this._time_machine._wasm_instance.instance.exports[key];
      if (typeof e === "function") {
        const wrapped_function = (...args) => {
          this.call(key, ...args);
        };
        wrapped_function.callAndRevert = (...args) => {
          this._in_call_that_will_be_reverted = true;
          this.call_and_revert(key, ...args);
          this._in_call_that_will_be_reverted = false;
        };
        export_object[key] = wrapped_function;
      }
    }
    return export_object;
  }
  async _run_inner_function(f, enqueue_condition = false) {
    if (!this._block_reentrancy && !enqueue_condition) {
      this._block_reentrancy = true;
      await f();
      let f1 = this._enqueued_inner_calls.shift();
      while (f1) {
        await f1();
        f1 = this._enqueued_inner_calls.shift();
      }
      this._block_reentrancy = false;
    } else {
      this._enqueued_inner_calls.push(f);
    }
  }
  _request_heap() {
    const lowest_latency_peer = this._room.get_lowest_latency_peer();
    if (lowest_latency_peer) {
      this._change_state(2 /* RequestingHeap */);
      this._room.send_message(this._encode_ping_message(), lowest_latency_peer);
      this._room.send_message(this._encode_request_heap_message(), lowest_latency_peer);
    }
  }
  _encode_wasm_call_message(function_index, time, args) {
    const message_writer = new MessageWriterReader(this._outgoing_message_buffer);
    message_writer.write_u8(0 /* WasmCall */);
    message_writer.write_u32(function_index);
    message_writer.write_f64(time);
    message_writer.write_u8(args.length);
    for (let i = 0; i < args.length; i++) {
      message_writer.write_f64(args[i]);
    }
    return this._outgoing_message_buffer.subarray(0, message_writer.offset);
  }
  _decode_wasm_call_message(data) {
    const message_reader = new MessageWriterReader(data);
    const function_index = message_reader.read_u32();
    const time = message_reader.read_f64();
    const args_length = message_reader.read_u8();
    const args = new Array(args_length);
    for (let i = 0; i < args.length; i++) {
      args[i] = message_reader.read_f64();
    }
    let hash;
    return {
      function_index,
      time,
      args,
      hash
    };
  }
  _encode_time_progressed_message(time_progressed) {
    const message_writer = new MessageWriterReader(this._outgoing_message_buffer);
    message_writer.write_u8(1 /* TimeProgressed */);
    message_writer.write_f64(time_progressed);
    return message_writer.get_result_array();
  }
  _decode_time_progressed_message(data) {
    return new DataView(data.buffer, data.byteOffset).getFloat64(0);
  }
  _encode_request_heap_message() {
    this._outgoing_message_buffer[0] = 2 /* RequestState */;
    return this._outgoing_message_buffer.subarray(0, 1);
  }
  _encode_ping_message() {
    const writer = new MessageWriterReader(this._outgoing_message_buffer);
    writer.write_u8(5 /* Ping */);
    writer.write_f64(Date.now());
    return writer.get_result_array();
  }
  _decode_pong_message(data) {
    const reader = new MessageWriterReader(data);
    const time_sent = reader.read_f64();
    const current_time = reader.read_f64();
    return { time_sent, current_time };
  }
  _process_args(args) {
    return args.map((a) => {
      if (a instanceof UserIdType) {
        return this._room.my_id;
      } else {
        return a;
      }
    });
  }
  _median_round_trip_latency() {
    const latencies = Array.from(this._peer_data.values()).map((peer) => peer.round_trip_time).sort();
    return latencies[Math.floor(latencies.length / 2)];
  }
  call(function_name, ...args) {
    this._run_inner_function(async () => {
      const args_processed = this._process_args(args);
      let median_round_trip_latency = this._median_round_trip_latency();
      if (median_round_trip_latency === void 0 || median_round_trip_latency < 60) {
        median_round_trip_latency = 0;
      }
      median_round_trip_latency = Math.min(median_round_trip_latency, 150);
      const message_time = Math.max(this._last_sent_message, this._time_machine.target_time() + median_round_trip_latency) + this._message_time_offset;
      const time_stamp = {
        time: message_time,
        player_id: this._room.my_id
      };
      this._message_time_offset += 1e-4;
      const function_index = this._time_machine.get_function_export_index(function_name);
      if (function_index !== void 0) {
        await this._time_machine.call_with_time_stamp(function_index, args_processed, time_stamp);
        if (this._tangle_state == 1 /* Connected */) {
          this._room.send_message(this._encode_ping_message());
          this._room.send_message(this._encode_wasm_call_message(function_index, time_stamp.time, args_processed));
        }
        this._last_sent_message = Math.max(this._last_sent_message, time_stamp.time);
      }
    });
    this.progress_time();
  }
  /// This call will have no impact but can be useful to draw or query from the world.
  call_and_revert(function_name, ...args) {
    this.progress_time();
    this._run_inner_function(async () => {
      const args_processed = this._process_args(args);
      const function_index = this._time_machine.get_function_export_index(function_name);
      if (function_index) {
        this._time_machine.call_and_revert(function_index, args_processed);
      }
    });
  }
  /// Resync with the room, immediately catching up.
  resync() {
    this._run_inner_function(() => {
      this._request_heap();
    });
  }
  progress_time() {
    this._run_inner_function(async () => {
      await this._progress_time_inner();
    });
  }
  async _progress_time_inner() {
    const performance_now = performance.now();
    if (this._last_performance_now) {
      const average_current_time = this._average_current_time(performance_now);
      const difference_from_peers = average_current_time - this.current_time(performance_now);
      let time_progressed = performance_now - this._last_performance_now + difference_from_peers;
      time_progressed = Math.max(time_progressed, 1e-3);
      const check_for_resync = true;
      if (check_for_resync && this._tangle_state == 1 /* Connected */) {
        const time_diff = this._time_machine.target_time() + time_progressed - this._time_machine.current_simulation_time();
        if (this._time_machine._fixed_update_interval !== void 0 && time_diff > 3e3) {
          time_progressed = this._time_machine._fixed_update_interval;
          if (this._peer_data.size > 0) {
            console.log("[tangle] Fallen behind, reloading room");
            console.log("Fallen behind amount: ", time_diff);
            location.reload();
          } else {
            console.log("[tangle] Fallen behind but this is a single-player session, so ignoring this");
          }
        }
      }
      await this._time_machine.progress_time(time_progressed);
      const time_budget = time_progressed * 0.7;
      const time_here = performance.now();
      while (this._time_machine.step()) {
        this._time_machine.take_snapshot();
        if (performance.now() - time_here > time_budget) {
          break;
        }
      }
      let earliest_safe_memory = this._time_machine.current_simulation_time();
      if (this._tangle_state == 1 /* Connected */) {
        for (const value of this._peer_data.values()) {
          earliest_safe_memory = Math.min(earliest_safe_memory, value.last_received_message);
        }
        const KEEP_ALIVE_THRESHOLD = 200;
        const current_time = this._time_machine.target_time();
        const difference = current_time - this._last_sent_message;
        if (difference > KEEP_ALIVE_THRESHOLD) {
          this._room.send_message(this._encode_ping_message());
          this._room.send_message(this._encode_time_progressed_message(current_time));
        }
      }
      this._time_machine.remove_history_before(earliest_safe_memory);
      if (time_progressed > 0) {
        this._message_time_offset = 1e-4;
      }
    }
    this._last_performance_now = performance_now;
  }
  _average_current_time(now) {
    let current_time = this._time_machine.target_time();
    if (this._last_performance_now) {
      current_time += now - this._last_performance_now;
    }
    let count = 1;
    if (this._tangle_state == 1 /* Connected */) {
      for (const peer of this._peer_data.values()) {
        if (peer.estimated_current_time) {
          current_time += peer.estimated_current_time + (now - peer.estimated_current_time_measurement);
          count += 1;
        }
      }
    }
    current_time = current_time / count;
    return current_time;
  }
  current_time(now) {
    let time = this._time_machine.target_time();
    if (this._last_performance_now) {
      time += now - this._last_performance_now;
    }
    return time;
  }
  read_memory(address, length) {
    return this._time_machine.read_memory(address, length);
  }
  read_string(address, length) {
    return this._time_machine.read_string(address, length);
  }
  print_history() {
    this._time_machine.print_history();
  }
};

// wasm/tangleshoot.js
var lAudioContext = typeof AudioContext !== "undefined" ? AudioContext : typeof webkitAudioContext !== "undefined" ? webkitAudioContext : void 0;
var tangle;
var heap = new Array(128).fill(void 0);
heap.push(void 0, null, true, false);
function getObject(idx) {
  return heap[idx];
}
var heap_next = heap.length;
function dropObject(idx) {
  if (idx < 132)
    return;
  heap[idx] = heap_next;
  heap_next = idx;
}
function takeObject(idx) {
  const ret2 = getObject(idx);
  dropObject(idx);
  return ret2;
}
function addHeapObject(obj) {
  if (heap_next === heap.length)
    heap.push(heap.length + 1);
  const idx = heap_next;
  heap_next = heap[idx];
  heap[idx] = obj;
  return idx;
}
var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
var cachedUint8Memory0 = null;
function getUint8Memory0() {
  if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {
    cachedUint8Memory0 = new Uint8Array(tangle._time_machine._wasm_instance.instance.exports.memory.buffer);
  }
  return cachedUint8Memory0;
}
function getStringFromWasm0(ptr, len) {
  return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
}
function isLikeNone(x) {
  return x === void 0 || x === null;
}
var cachedFloat64Memory0 = null;
function getFloat64Memory0() {
  if (cachedFloat64Memory0 === null || cachedFloat64Memory0.byteLength === 0) {
    cachedFloat64Memory0 = new Float64Array(tangle._time_machine._wasm_instance.instance.exports.memory.buffer);
  }
  return cachedFloat64Memory0;
}
var cachedInt32Memory0 = null;
function getInt32Memory0() {
  if (cachedInt32Memory0 === null || cachedInt32Memory0.byteLength === 0) {
    cachedInt32Memory0 = new Int32Array(tangle._time_machine._wasm_instance.instance.exports.memory.buffer);
  }
  return cachedInt32Memory0;
}
var WASM_VECTOR_LEN = 0;
var cachedTextEncoder = new TextEncoder("utf-8");
var encodeString = typeof cachedTextEncoder.encodeInto === "function" ? function(arg, view) {
  return cachedTextEncoder.encodeInto(arg, view);
} : function(arg, view) {
  const buf = cachedTextEncoder.encode(arg);
  view.set(buf);
  return {
    read: arg.length,
    written: buf.length
  };
};
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length);
    getUint8Memory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len);
  const mem = getUint8Memory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127)
      break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3);
    const view = getUint8Memory0().subarray(ptr + offset, ptr + len);
    const ret2 = encodeString(arg, view);
    offset += ret2.written;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
function debugString(val) {
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  if (Array.isArray(val)) {
    const length = val.length;
    let debug = "[";
    if (length > 0) {
      debug += debugString(val[0]);
    }
    for (let i = 1; i < length; i++) {
      debug += ", " + debugString(val[i]);
    }
    debug += "]";
    return debug;
  }
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    return toString.call(val);
  }
  if (className == "Object") {
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_) {
      return "Object";
    }
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}
${val.stack}`;
  }
  return className;
}
function makeMutClosure(arg02, arg12, dtor, f) {
  const state = { a: arg02, b: arg12, cnt: 1, dtor };
  const real = (...args) => {
    state.cnt++;
    const a = state.a;
    state.a = 0;
    try {
      return f(a, state.b, ...args);
    } finally {
      if (--state.cnt === 0) {
        tangle._time_machine._wasm_instance.instance.exports.__wbindgen_export_2.get(state.dtor)(a, state.b);
      } else {
        state.a = a;
      }
    }
  };
  real.original = state;
  return real;
}
function __wbg_adapter_34(arg02, arg12) {
  tangle._time_machine._wasm_instance.instance.exports._dyn_core__ops__function__FnMut_____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__hd5f5c26d8d9598f9(arg02, arg12);
}
function __wbg_adapter_37(arg02, arg12, arg2) {
  tangle._time_machine._wasm_instance.instance.exports._dyn_core__ops__function__FnMut__A____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__h02fbbe34bb05a4ed(arg02, arg12, addHeapObject(arg2));
}
function __wbg_adapter_54(arg02, arg12) {
  tangle._time_machine._wasm_instance.instance.exports._dyn_core__ops__function__FnMut_____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__h536915ecfde7be24(arg02, arg12);
}
function __wbg_adapter_57(arg02, arg12, arg2) {
  tangle._time_machine._wasm_instance.instance.exports._dyn_core__ops__function__FnMut__A____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__ha90a6027cae409b3(arg02, arg12, addHeapObject(arg2));
}
function start() {
  tangle._time_machine._wasm_instance.instance.exports.start();
}
function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    tangle._time_machine._wasm_instance.instance.exports.__wbindgen_exn_store(addHeapObject(e));
  }
}
function getArrayU8FromWasm0(ptr, len) {
  return getUint8Memory0().subarray(ptr / 1, ptr / 1 + len);
}
var cachedFloat32Memory0 = null;
function getFloat32Memory0() {
  if (cachedFloat32Memory0 === null || cachedFloat32Memory0.byteLength === 0) {
    cachedFloat32Memory0 = new Float32Array(tangle._time_machine._wasm_instance.instance.exports.memory.buffer);
  }
  return cachedFloat32Memory0;
}
function getArrayF32FromWasm0(ptr, len) {
  return getFloat32Memory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayI32FromWasm0(ptr, len) {
  return getInt32Memory0().subarray(ptr / 4, ptr / 4 + len);
}
var cachedUint32Memory0 = null;
function getUint32Memory0() {
  if (cachedUint32Memory0 === null || cachedUint32Memory0.byteLength === 0) {
    cachedUint32Memory0 = new Uint32Array(tangle._time_machine._wasm_instance.instance.exports.memory.buffer);
  }
  return cachedUint32Memory0;
}
function getArrayU32FromWasm0(ptr, len) {
  return getUint32Memory0().subarray(ptr / 4, ptr / 4 + len);
}
function notDefined(what) {
  return () => {
    throw new Error(`${what} is not defined`);
  };
}
async function load(module2, imports2) {
  if (typeof Response === "function" && module2 instanceof Response) {
    if (typeof Tangle.instantiateStreaming === "function") {
      try {
        return await Tangle.instantiateStreaming(module2, imports2);
      } catch (e) {
        if (module2.headers.get("Content-Type") != "application/wasm") {
          console.warn("`Tangle.instantiateStreaming` failed because your server does not serve wasm with `application/wasm` MIME type. Falling back to `Tangle.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module2.arrayBuffer();
    return await Tangle.instantiate(bytes, imports2);
  } else {
    const instance = await Tangle.instantiate(module2, imports2);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module: module2 };
    } else {
      return instance;
    }
  }
}
function getImports() {
  const imports = {};
  imports.wbg = {};
  imports.wbg.__wbindgen_object_drop_ref = function(arg02) {
    takeObject(arg02);
  };
  imports.wbg.__wbindgen_object_clone_ref = function(arg02) {
    const ret2 = getObject(arg02);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_cb_drop = function(arg02) {
    const obj = takeObject(arg02).original;
    if (obj.cnt-- == 1) {
      obj.a = 0;
      return true;
    }
    const ret2 = false;
    return ret2;
  };
  imports.wbg.__wbindgen_string_new = function(arg02, arg12) {
    const ret2 = getStringFromWasm0(arg02, arg12);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_number_get = function(arg02, arg12) {
    const obj = getObject(arg12);
    const ret2 = typeof obj === "number" ? obj : void 0;
    getFloat64Memory0()[arg02 / 8 + 1] = isLikeNone(ret2) ? 0 : ret2;
    getInt32Memory0()[arg02 / 4 + 0] = !isLikeNone(ret2);
  };
  imports.wbg.__wbindgen_is_null = function(arg02) {
    const ret2 = getObject(arg02) === null;
    return ret2;
  };
  imports.wbg.__wbindgen_boolean_get = function(arg02) {
    const v = getObject(arg02);
    const ret2 = typeof v === "boolean" ? v ? 1 : 0 : 2;
    return ret2;
  };
  imports.wbg.__wbindgen_string_get = function(arg02, arg12) {
    const obj = getObject(arg12);
    const ret2 = typeof obj === "string" ? obj : void 0;
    var ptr0 = isLikeNone(ret2) ? 0 : passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    var len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbindgen_number_new = function(arg02) {
    const ret2 = arg02;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_log_c9486ca5d8e2cbe8 = function(arg02, arg12) {
    try {
      console.log(getStringFromWasm0(arg02, arg12));
    } finally {
      tangle._time_machine._wasm_instance.instance.exports.__wbindgen_free(arg02, arg12);
    }
  };
  imports.wbg.__wbg_log_aba5996d9bde071f = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7) {
    try {
      console.log(getStringFromWasm0(arg02, arg12), getStringFromWasm0(arg2, arg3), getStringFromWasm0(arg4, arg5), getStringFromWasm0(arg6, arg7));
    } finally {
      tangle._time_machine._wasm_instance.instance.exports.__wbindgen_free(arg02, arg12);
    }
  };
  imports.wbg.__wbg_mark_40e050a77cc39fea = function(arg02, arg12) {
    performance.mark(getStringFromWasm0(arg02, arg12));
  };
  imports.wbg.__wbg_measure_aa7a73f17813f708 = function() {
    return handleError(function(arg02, arg12, arg2, arg3) {
      try {
        performance.measure(getStringFromWasm0(arg02, arg12), getStringFromWasm0(arg2, arg3));
      } finally {
        tangle._time_machine._wasm_instance.instance.exports.__wbindgen_free(arg02, arg12);
        tangle._time_machine._wasm_instance.instance.exports.__wbindgen_free(arg2, arg3);
      }
    }, arguments);
  };
  imports.wbg.__wbg_new_abda76e883ba8a5f = function() {
    const ret2 = new Error();
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_stack_658279fe44541cf6 = function(arg02, arg12) {
    const ret2 = getObject(arg12).stack;
    const ptr0 = passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_error_f851667af71bcfc6 = function(arg02, arg12) {
    try {
      console.error(getStringFromWasm0(arg02, arg12));
    } finally {
      tangle._time_machine._wasm_instance.instance.exports.__wbindgen_free(arg02, arg12);
    }
  };
  imports.wbg.__wbg_randomFillSync_6894564c2c334c42 = function() {
    return handleError(function(arg02, arg12, arg2) {
      getObject(arg02).randomFillSync(getArrayU8FromWasm0(arg12, arg2));
    }, arguments);
  };
  imports.wbg.__wbg_getRandomValues_805f1c3d65988a5a = function() {
    return handleError(function(arg02, arg12) {
      getObject(arg02).getRandomValues(getObject(arg12));
    }, arguments);
  };
  imports.wbg.__wbg_crypto_e1d53a1d73fb10b8 = function(arg02) {
    const ret2 = getObject(arg02).crypto;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_is_object = function(arg02) {
    const val = getObject(arg02);
    const ret2 = typeof val === "object" && val !== null;
    return ret2;
  };
  imports.wbg.__wbg_process_038c26bf42b093f8 = function(arg02) {
    const ret2 = getObject(arg02).process;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_versions_ab37218d2f0b24a8 = function(arg02) {
    const ret2 = getObject(arg02).versions;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_node_080f4b19d15bc1fe = function(arg02) {
    const ret2 = getObject(arg02).node;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_is_string = function(arg02) {
    const ret2 = typeof getObject(arg02) === "string";
    return ret2;
  };
  imports.wbg.__wbg_msCrypto_6e7d3e1f92610cbb = function(arg02) {
    const ret2 = getObject(arg02).msCrypto;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_require_78a3dcfbdba9cbce = function() {
    return handleError(function() {
      const ret2 = module.require;
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbindgen_is_function = function(arg02) {
    const ret2 = typeof getObject(arg02) === "function";
    return ret2;
  };
  imports.wbg.__wbg_instanceof_WebGl2RenderingContext_61bb2cb23346dbb7 = function(arg02) {
    let result;
    try {
      result = getObject(arg02) instanceof WebGL2RenderingContext;
    } catch {
      result = false;
    }
    const ret2 = result;
    return ret2;
  };
  imports.wbg.__wbg_beginQuery_fb152d8d84f2b130 = function(arg02, arg12, arg2) {
    getObject(arg02).beginQuery(arg12 >>> 0, getObject(arg2));
  };
  imports.wbg.__wbg_bindBufferRange_f2c529259df5358e = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).bindBufferRange(arg12 >>> 0, arg2 >>> 0, getObject(arg3), arg4, arg5);
  };
  imports.wbg.__wbg_bindSampler_6eb88b542e5a410f = function(arg02, arg12, arg2) {
    getObject(arg02).bindSampler(arg12 >>> 0, getObject(arg2));
  };
  imports.wbg.__wbg_bindVertexArray_8b71290041cb6746 = function(arg02, arg12) {
    getObject(arg02).bindVertexArray(getObject(arg12));
  };
  imports.wbg.__wbg_blitFramebuffer_86eee8a5763ded5e = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
    getObject(arg02).blitFramebuffer(arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0);
  };
  imports.wbg.__wbg_bufferData_573e61c49a480c4d = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).bufferData(arg12 >>> 0, arg2, arg3 >>> 0);
  };
  imports.wbg.__wbg_bufferData_16f948547d74c866 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).bufferData(arg12 >>> 0, getObject(arg2), arg3 >>> 0);
  };
  imports.wbg.__wbg_bufferSubData_c7180c0b681078e8 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).bufferSubData(arg12 >>> 0, arg2, getObject(arg3));
  };
  imports.wbg.__wbg_clearBufferfi_95daf829c568e58a = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).clearBufferfi(arg12 >>> 0, arg2, arg3, arg4);
  };
  imports.wbg.__wbg_clearBufferfv_b3c90fbed3b74920 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).clearBufferfv(arg12 >>> 0, arg2, getArrayF32FromWasm0(arg3, arg4));
  };
  imports.wbg.__wbg_clearBufferiv_fe2a00a8f8fb7322 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).clearBufferiv(arg12 >>> 0, arg2, getArrayI32FromWasm0(arg3, arg4));
  };
  imports.wbg.__wbg_clearBufferuiv_a41730a8d84c6ac6 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).clearBufferuiv(arg12 >>> 0, arg2, getArrayU32FromWasm0(arg3, arg4));
  };
  imports.wbg.__wbg_clientWaitSync_ae8f3712f85a57fb = function(arg02, arg12, arg2, arg3) {
    const ret2 = getObject(arg02).clientWaitSync(getObject(arg12), arg2 >>> 0, arg3 >>> 0);
    return ret2;
  };
  imports.wbg.__wbg_compressedTexSubImage2D_23b602b828848fb7 = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    getObject(arg02).compressedTexSubImage2D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8, arg9);
  };
  imports.wbg.__wbg_compressedTexSubImage2D_d6c95fc640a9f4de = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
    getObject(arg02).compressedTexSubImage2D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, getObject(arg8));
  };
  imports.wbg.__wbg_compressedTexSubImage3D_00b794917e65d559 = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
    getObject(arg02).compressedTexSubImage3D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10, arg11);
  };
  imports.wbg.__wbg_compressedTexSubImage3D_c9c7b42e0f7db586 = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
    getObject(arg02).compressedTexSubImage3D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, getObject(arg10));
  };
  imports.wbg.__wbg_copyBufferSubData_c903618a0e0a9fca = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).copyBufferSubData(arg12 >>> 0, arg2 >>> 0, arg3, arg4, arg5);
  };
  imports.wbg.__wbg_copyTexSubImage3D_88fc9e1c56d3e7db = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    getObject(arg02).copyTexSubImage3D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
  };
  imports.wbg.__wbg_createSampler_d1255ae3836b1bee = function(arg02) {
    const ret2 = getObject(arg02).createSampler();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createVertexArray_de7292bbd7ea02dd = function(arg02) {
    const ret2 = getObject(arg02).createVertexArray();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_deleteQuery_0981fb4d492e46a7 = function(arg02, arg12) {
    getObject(arg02).deleteQuery(getObject(arg12));
  };
  imports.wbg.__wbg_deleteSampler_6d832d1900eafbea = function(arg02, arg12) {
    getObject(arg02).deleteSampler(getObject(arg12));
  };
  imports.wbg.__wbg_deleteSync_f8f026807b7eee54 = function(arg02, arg12) {
    getObject(arg02).deleteSync(getObject(arg12));
  };
  imports.wbg.__wbg_deleteVertexArray_dc4f1b2e5ac93f24 = function(arg02, arg12) {
    getObject(arg02).deleteVertexArray(getObject(arg12));
  };
  imports.wbg.__wbg_drawArraysInstanced_1222b6236d008088 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).drawArraysInstanced(arg12 >>> 0, arg2, arg3, arg4);
  };
  imports.wbg.__wbg_drawBuffers_3223f0aeb44f7057 = function(arg02, arg12) {
    getObject(arg02).drawBuffers(getObject(arg12));
  };
  imports.wbg.__wbg_drawElementsInstanced_b4714f8dd90fd2a8 = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).drawElementsInstanced(arg12 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
  };
  imports.wbg.__wbg_endQuery_726967da9d5d1ca7 = function(arg02, arg12) {
    getObject(arg02).endQuery(arg12 >>> 0);
  };
  imports.wbg.__wbg_fenceSync_fb3e1185847ee462 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).fenceSync(arg12 >>> 0, arg2 >>> 0);
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_framebufferTextureLayer_e644333b8ec36f9d = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).framebufferTextureLayer(arg12 >>> 0, arg2 >>> 0, getObject(arg3), arg4, arg5);
  };
  imports.wbg.__wbg_getBufferSubData_cd8138c86821bca3 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).getBufferSubData(arg12 >>> 0, arg2, getObject(arg3));
  };
  imports.wbg.__wbg_getIndexedParameter_5f5c79f6c05edd18 = function() {
    return handleError(function(arg02, arg12, arg2) {
      const ret2 = getObject(arg02).getIndexedParameter(arg12 >>> 0, arg2 >>> 0);
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_getQueryParameter_e0f43fb85f793bbe = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).getQueryParameter(getObject(arg12), arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_getSyncParameter_b2f55318719e958c = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).getSyncParameter(getObject(arg12), arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_getUniformBlockIndex_a05b0c144aa49817 = function(arg02, arg12, arg2, arg3) {
    const ret2 = getObject(arg02).getUniformBlockIndex(getObject(arg12), getStringFromWasm0(arg2, arg3));
    return ret2;
  };
  imports.wbg.__wbg_invalidateFramebuffer_696c3c456c34a207 = function() {
    return handleError(function(arg02, arg12, arg2) {
      getObject(arg02).invalidateFramebuffer(arg12 >>> 0, getObject(arg2));
    }, arguments);
  };
  imports.wbg.__wbg_readBuffer_bade27c1171e00cf = function(arg02, arg12) {
    getObject(arg02).readBuffer(arg12 >>> 0);
  };
  imports.wbg.__wbg_readPixels_493558abd28a3b61 = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7) {
      getObject(arg02).readPixels(arg12, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, getObject(arg7));
    }, arguments);
  };
  imports.wbg.__wbg_readPixels_92102ee9fe1c81a0 = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7) {
      getObject(arg02).readPixels(arg12, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7);
    }, arguments);
  };
  imports.wbg.__wbg_renderbufferStorageMultisample_9cb173d2fd461513 = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).renderbufferStorageMultisample(arg12 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
  };
  imports.wbg.__wbg_samplerParameterf_38ca759dc5c40461 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).samplerParameterf(getObject(arg12), arg2 >>> 0, arg3);
  };
  imports.wbg.__wbg_samplerParameteri_c631c02ceefc6dc1 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).samplerParameteri(getObject(arg12), arg2 >>> 0, arg3);
  };
  imports.wbg.__wbg_texStorage2D_89c29252632da923 = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).texStorage2D(arg12 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
  };
  imports.wbg.__wbg_texStorage3D_3897fb6b91eb82d8 = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6) {
    getObject(arg02).texStorage3D(arg12 >>> 0, arg2, arg3 >>> 0, arg4, arg5, arg6);
  };
  imports.wbg.__wbg_texSubImage2D_6a8b0f3381d734c3 = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
      getObject(arg02).texSubImage2D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, getObject(arg9));
    }, arguments);
  };
  imports.wbg.__wbg_texSubImage2D_53b6a050a0b9b24e = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
      getObject(arg02).texSubImage2D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
    }, arguments);
  };
  imports.wbg.__wbg_texSubImage3D_84ef903e11598af0 = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
      getObject(arg02).texSubImage3D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
    }, arguments);
  };
  imports.wbg.__wbg_texSubImage3D_1d82135e9ce965bf = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
      getObject(arg02).texSubImage3D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, getObject(arg11));
    }, arguments);
  };
  imports.wbg.__wbg_uniform2fv_ffd0b1d3c3a4070a = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform2fv(getObject(arg12), getArrayF32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniform2iv_32329f9a4d491136 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform2iv(getObject(arg12), getArrayI32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniform3fv_bc831e48acb2c057 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform3fv(getObject(arg12), getArrayF32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniform3iv_100a284f5a3cbca5 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform3iv(getObject(arg12), getArrayI32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniform4fv_26d822da5c3fdb00 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform4fv(getObject(arg12), getArrayF32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniform4iv_7f03c41e6e49bbd6 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform4iv(getObject(arg12), getArrayI32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniformBlockBinding_1971f4528d9c3043 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniformBlockBinding(getObject(arg12), arg2 >>> 0, arg3 >>> 0);
  };
  imports.wbg.__wbg_uniformMatrix2fv_5f1f56c7cbfb533f = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).uniformMatrix2fv(getObject(arg12), arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
  };
  imports.wbg.__wbg_uniformMatrix3fv_ae9271db8127a57b = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).uniformMatrix3fv(getObject(arg12), arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
  };
  imports.wbg.__wbg_uniformMatrix4fv_0f42d678a568ded9 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).uniformMatrix4fv(getObject(arg12), arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
  };
  imports.wbg.__wbg_vertexAttribDivisor_77f020121066a4d9 = function(arg02, arg12, arg2) {
    getObject(arg02).vertexAttribDivisor(arg12 >>> 0, arg2 >>> 0);
  };
  imports.wbg.__wbg_vertexAttribIPointer_b15ad1437a268cf5 = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).vertexAttribIPointer(arg12 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
  };
  imports.wbg.__wbg_activeTexture_0daf7c1698e49f00 = function(arg02, arg12) {
    getObject(arg02).activeTexture(arg12 >>> 0);
  };
  imports.wbg.__wbg_attachShader_3038234860d2d59d = function(arg02, arg12, arg2) {
    getObject(arg02).attachShader(getObject(arg12), getObject(arg2));
  };
  imports.wbg.__wbg_bindBuffer_9cb064991696b79f = function(arg02, arg12, arg2) {
    getObject(arg02).bindBuffer(arg12 >>> 0, getObject(arg2));
  };
  imports.wbg.__wbg_bindFramebuffer_0522db2a250c29f0 = function(arg02, arg12, arg2) {
    getObject(arg02).bindFramebuffer(arg12 >>> 0, getObject(arg2));
  };
  imports.wbg.__wbg_bindRenderbuffer_1e4928d9bf839c02 = function(arg02, arg12, arg2) {
    getObject(arg02).bindRenderbuffer(arg12 >>> 0, getObject(arg2));
  };
  imports.wbg.__wbg_bindTexture_0c284b1604ba527c = function(arg02, arg12, arg2) {
    getObject(arg02).bindTexture(arg12 >>> 0, getObject(arg2));
  };
  imports.wbg.__wbg_blendColor_a17ddceb3534e0b3 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).blendColor(arg12, arg2, arg3, arg4);
  };
  imports.wbg.__wbg_blendEquation_b5d5be767bd3835a = function(arg02, arg12) {
    getObject(arg02).blendEquation(arg12 >>> 0);
  };
  imports.wbg.__wbg_blendEquationSeparate_d2fa3b718ee3579f = function(arg02, arg12, arg2) {
    getObject(arg02).blendEquationSeparate(arg12 >>> 0, arg2 >>> 0);
  };
  imports.wbg.__wbg_blendFunc_d456b0c766f8dbc9 = function(arg02, arg12, arg2) {
    getObject(arg02).blendFunc(arg12 >>> 0, arg2 >>> 0);
  };
  imports.wbg.__wbg_blendFuncSeparate_9a7146974b3cd76d = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).blendFuncSeparate(arg12 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
  };
  imports.wbg.__wbg_colorMask_a7f067283ed312c9 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).colorMask(arg12 !== 0, arg2 !== 0, arg3 !== 0, arg4 !== 0);
  };
  imports.wbg.__wbg_compileShader_af777dd3b15798b3 = function(arg02, arg12) {
    getObject(arg02).compileShader(getObject(arg12));
  };
  imports.wbg.__wbg_copyTexSubImage2D_47b14ff8459fd4c8 = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
    getObject(arg02).copyTexSubImage2D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
  };
  imports.wbg.__wbg_createBuffer_5ed0554ab35780b5 = function(arg02) {
    const ret2 = getObject(arg02).createBuffer();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createFramebuffer_86883935c13ddd59 = function(arg02) {
    const ret2 = getObject(arg02).createFramebuffer();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createProgram_7d25c1dd3bb0ce39 = function(arg02) {
    const ret2 = getObject(arg02).createProgram();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createRenderbuffer_b392324e044d389a = function(arg02) {
    const ret2 = getObject(arg02).createRenderbuffer();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createShader_96339db58713e350 = function(arg02, arg12) {
    const ret2 = getObject(arg02).createShader(arg12 >>> 0);
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createTexture_c651f9e28d1ce9d2 = function(arg02) {
    const ret2 = getObject(arg02).createTexture();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_cullFace_79e4ddbea13278b3 = function(arg02, arg12) {
    getObject(arg02).cullFace(arg12 >>> 0);
  };
  imports.wbg.__wbg_deleteBuffer_cf67a696a7857b3f = function(arg02, arg12) {
    getObject(arg02).deleteBuffer(getObject(arg12));
  };
  imports.wbg.__wbg_deleteFramebuffer_f9c2bceeb5422d9d = function(arg02, arg12) {
    getObject(arg02).deleteFramebuffer(getObject(arg12));
  };
  imports.wbg.__wbg_deleteProgram_9c8fa1ef341cb01d = function(arg02, arg12) {
    getObject(arg02).deleteProgram(getObject(arg12));
  };
  imports.wbg.__wbg_deleteRenderbuffer_cad502ac8d1398f2 = function(arg02, arg12) {
    getObject(arg02).deleteRenderbuffer(getObject(arg12));
  };
  imports.wbg.__wbg_deleteShader_f48f72524f5ee3ed = function(arg02, arg12) {
    getObject(arg02).deleteShader(getObject(arg12));
  };
  imports.wbg.__wbg_deleteTexture_1b5f5e536e0d5545 = function(arg02, arg12) {
    getObject(arg02).deleteTexture(getObject(arg12));
  };
  imports.wbg.__wbg_depthFunc_2060ec3687ac1f95 = function(arg02, arg12) {
    getObject(arg02).depthFunc(arg12 >>> 0);
  };
  imports.wbg.__wbg_depthMask_27d367443a80541d = function(arg02, arg12) {
    getObject(arg02).depthMask(arg12 !== 0);
  };
  imports.wbg.__wbg_depthRange_7109c2393819a37b = function(arg02, arg12, arg2) {
    getObject(arg02).depthRange(arg12, arg2);
  };
  imports.wbg.__wbg_disable_3adb8645ea1d92d4 = function(arg02, arg12) {
    getObject(arg02).disable(arg12 >>> 0);
  };
  imports.wbg.__wbg_disableVertexAttribArray_f469283fda607cee = function(arg02, arg12) {
    getObject(arg02).disableVertexAttribArray(arg12 >>> 0);
  };
  imports.wbg.__wbg_drawArrays_84de8a2416396807 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).drawArrays(arg12 >>> 0, arg2, arg3);
  };
  imports.wbg.__wbg_drawElements_dcb8df9c52e2bbd5 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).drawElements(arg12 >>> 0, arg2, arg3 >>> 0, arg4);
  };
  imports.wbg.__wbg_enable_1ac9f14a577b7c8b = function(arg02, arg12) {
    getObject(arg02).enable(arg12 >>> 0);
  };
  imports.wbg.__wbg_enableVertexAttribArray_53139716d9c95dba = function(arg02, arg12) {
    getObject(arg02).enableVertexAttribArray(arg12 >>> 0);
  };
  imports.wbg.__wbg_framebufferRenderbuffer_77bdb2f359a5728f = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).framebufferRenderbuffer(arg12 >>> 0, arg2 >>> 0, arg3 >>> 0, getObject(arg4));
  };
  imports.wbg.__wbg_framebufferTexture2D_885176f16a153fec = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).framebufferTexture2D(arg12 >>> 0, arg2 >>> 0, arg3 >>> 0, getObject(arg4), arg5);
  };
  imports.wbg.__wbg_frontFace_3d7784c56ffede8a = function(arg02, arg12) {
    getObject(arg02).frontFace(arg12 >>> 0);
  };
  imports.wbg.__wbg_getActiveUniform_9c4ac7c1ccf5f894 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).getActiveUniform(getObject(arg12), arg2 >>> 0);
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_getExtension_f0070583175271d4 = function() {
    return handleError(function(arg02, arg12, arg2) {
      const ret2 = getObject(arg02).getExtension(getStringFromWasm0(arg12, arg2));
      return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_getParameter_56d47f9b55e463d4 = function() {
    return handleError(function(arg02, arg12) {
      const ret2 = getObject(arg02).getParameter(arg12 >>> 0);
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_getProgramInfoLog_7654794297967ac0 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg12).getProgramInfoLog(getObject(arg2));
    var ptr0 = isLikeNone(ret2) ? 0 : passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    var len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_getProgramParameter_5b1a40917aa850f8 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).getProgramParameter(getObject(arg12), arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_getShaderInfoLog_915d0e8506c11159 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg12).getShaderInfoLog(getObject(arg2));
    var ptr0 = isLikeNone(ret2) ? 0 : passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    var len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_getShaderParameter_f9240892c9e7a0a3 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).getShaderParameter(getObject(arg12), arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_getSupportedExtensions_7af8f7bbdd4d7b2c = function(arg02) {
    const ret2 = getObject(arg02).getSupportedExtensions();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_getUniformLocation_c6caabb349b43da7 = function(arg02, arg12, arg2, arg3) {
    const ret2 = getObject(arg02).getUniformLocation(getObject(arg12), getStringFromWasm0(arg2, arg3));
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_linkProgram_2d5cc584654696b8 = function(arg02, arg12) {
    getObject(arg02).linkProgram(getObject(arg12));
  };
  imports.wbg.__wbg_pixelStorei_a0b83efc92cd29fe = function(arg02, arg12, arg2) {
    getObject(arg02).pixelStorei(arg12 >>> 0, arg2);
  };
  imports.wbg.__wbg_polygonOffset_03d3955d5a1afa08 = function(arg02, arg12, arg2) {
    getObject(arg02).polygonOffset(arg12, arg2);
  };
  imports.wbg.__wbg_renderbufferStorage_2192d9cd09128339 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).renderbufferStorage(arg12 >>> 0, arg2 >>> 0, arg3, arg4);
  };
  imports.wbg.__wbg_scissor_2b084e0dc81d67f4 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).scissor(arg12, arg2, arg3, arg4);
  };
  imports.wbg.__wbg_shaderSource_57883245cdfb0dca = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).shaderSource(getObject(arg12), getStringFromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_stencilFuncSeparate_3be68afd7ca6efcc = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).stencilFuncSeparate(arg12 >>> 0, arg2 >>> 0, arg3, arg4 >>> 0);
  };
  imports.wbg.__wbg_stencilMask_144b86d15d9fdbe6 = function(arg02, arg12) {
    getObject(arg02).stencilMask(arg12 >>> 0);
  };
  imports.wbg.__wbg_stencilMaskSeparate_84a2494b967772c7 = function(arg02, arg12, arg2) {
    getObject(arg02).stencilMaskSeparate(arg12 >>> 0, arg2 >>> 0);
  };
  imports.wbg.__wbg_stencilOpSeparate_1708aea1aea0dc48 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).stencilOpSeparate(arg12 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
  };
  imports.wbg.__wbg_texParameteri_e0ce3810261e0864 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).texParameteri(arg12 >>> 0, arg2 >>> 0, arg3);
  };
  imports.wbg.__wbg_uniform1f_dcc6951bde745417 = function(arg02, arg12, arg2) {
    getObject(arg02).uniform1f(getObject(arg12), arg2);
  };
  imports.wbg.__wbg_uniform1i_4fdc6d6740375d22 = function(arg02, arg12, arg2) {
    getObject(arg02).uniform1i(getObject(arg12), arg2);
  };
  imports.wbg.__wbg_uniform4f_19b349303edb7836 = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).uniform4f(getObject(arg12), arg2, arg3, arg4, arg5);
  };
  imports.wbg.__wbg_useProgram_2f4094faf45ecba1 = function(arg02, arg12) {
    getObject(arg02).useProgram(getObject(arg12));
  };
  imports.wbg.__wbg_vertexAttribPointer_ad370785358334f4 = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6) {
    getObject(arg02).vertexAttribPointer(arg12 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
  };
  imports.wbg.__wbg_viewport_cc41e28a71c23915 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).viewport(arg12, arg2, arg3, arg4);
  };
  imports.wbg.__wbg_instanceof_Window_e266f02eee43b570 = function(arg02) {
    let result;
    try {
      result = getObject(arg02) instanceof Window;
    } catch {
      result = false;
    }
    const ret2 = result;
    return ret2;
  };
  imports.wbg.__wbg_document_950215a728589a2d = function(arg02) {
    const ret2 = getObject(arg02).document;
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_navigator_b18e629f7f0b75fa = function(arg02) {
    const ret2 = getObject(arg02).navigator;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_innerWidth_7e9d12e05bcb598e = function() {
    return handleError(function(arg02) {
      const ret2 = getObject(arg02).innerWidth;
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_innerHeight_3ef25a30618357e0 = function() {
    return handleError(function(arg02) {
      const ret2 = getObject(arg02).innerHeight;
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_devicePixelRatio_5f8f5cab76864090 = function(arg02) {
    const ret2 = getObject(arg02).devicePixelRatio;
    return ret2;
  };
  imports.wbg.__wbg_isSecureContext_c3e5510caacaa0ce = function(arg02) {
    const ret2 = getObject(arg02).isSecureContext;
    return ret2;
  };
  imports.wbg.__wbg_cancelAnimationFrame_d079cdb83bc43b26 = function() {
    return handleError(function(arg02, arg12) {
      getObject(arg02).cancelAnimationFrame(arg12);
    }, arguments);
  };
  imports.wbg.__wbg_matchMedia_967e50e4289050fa = function() {
    return handleError(function(arg02, arg12, arg2) {
      const ret2 = getObject(arg02).matchMedia(getStringFromWasm0(arg12, arg2));
      return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_requestAnimationFrame_afe426b568f84138 = function() {
    return handleError(function(arg02, arg12) {
      const ret2 = getObject(arg02).requestAnimationFrame(getObject(arg12));
      return ret2;
    }, arguments);
  };
  imports.wbg.__wbg_get_e6ae480a4b8df368 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02)[getStringFromWasm0(arg12, arg2)];
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_clearTimeout_b2b8af0f044e02e9 = function(arg02, arg12) {
    getObject(arg02).clearTimeout(arg12);
  };
  imports.wbg.__wbg_fetch_e8596d8a939a0853 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).fetch(getStringFromWasm0(arg12, arg2));
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_setTimeout_6609c9aa64f32bfc = function() {
    return handleError(function(arg02, arg12, arg2) {
      const ret2 = getObject(arg02).setTimeout(getObject(arg12), arg2);
      return ret2;
    }, arguments);
  };
  imports.wbg.__wbg_setbuffer_bad384d1628a8306 = function(arg02, arg12) {
    getObject(arg02).buffer = getObject(arg12);
  };
  imports.wbg.__wbg_setonended_15b13187aec41ac9 = function(arg02, arg12) {
    getObject(arg02).onended = getObject(arg12);
  };
  imports.wbg.__wbg_start_9169e040a16354b9 = function() {
    return handleError(function(arg02, arg12) {
      getObject(arg02).start(arg12);
    }, arguments);
  };
  imports.wbg.__wbg_connect_77f2f818a74097e1 = function() {
    return handleError(function(arg02, arg12) {
      const ret2 = getObject(arg02).connect(getObject(arg12));
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_addEventListener_615d4590d38da1c9 = function() {
    return handleError(function(arg02, arg12, arg2, arg3) {
      getObject(arg02).addEventListener(getStringFromWasm0(arg12, arg2), getObject(arg3));
    }, arguments);
  };
  imports.wbg.__wbg_addEventListener_cf5b03cd29763277 = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4) {
      getObject(arg02).addEventListener(getStringFromWasm0(arg12, arg2), getObject(arg3), getObject(arg4));
    }, arguments);
  };
  imports.wbg.__wbg_removeEventListener_86fd19ed073cd1ed = function() {
    return handleError(function(arg02, arg12, arg2, arg3) {
      getObject(arg02).removeEventListener(getStringFromWasm0(arg12, arg2), getObject(arg3));
    }, arguments);
  };
  imports.wbg.__wbg_charCode_504e79c3e550d1bb = function(arg02) {
    const ret2 = getObject(arg02).charCode;
    return ret2;
  };
  imports.wbg.__wbg_keyCode_b33194be2ceec53b = function(arg02) {
    const ret2 = getObject(arg02).keyCode;
    return ret2;
  };
  imports.wbg.__wbg_altKey_dff2a075455ac01b = function(arg02) {
    const ret2 = getObject(arg02).altKey;
    return ret2;
  };
  imports.wbg.__wbg_ctrlKey_993b558f853d64ce = function(arg02) {
    const ret2 = getObject(arg02).ctrlKey;
    return ret2;
  };
  imports.wbg.__wbg_shiftKey_31e62e9d172b26f0 = function(arg02) {
    const ret2 = getObject(arg02).shiftKey;
    return ret2;
  };
  imports.wbg.__wbg_metaKey_9f0f19692d0498bd = function(arg02) {
    const ret2 = getObject(arg02).metaKey;
    return ret2;
  };
  imports.wbg.__wbg_key_f0decac219aa904b = function(arg02, arg12) {
    const ret2 = getObject(arg12).key;
    const ptr0 = passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_code_aed21120de275a12 = function(arg02, arg12) {
    const ret2 = getObject(arg12).code;
    const ptr0 = passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_getModifierState_03b72700dbe33ad6 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).getModifierState(getStringFromWasm0(arg12, arg2));
    return ret2;
  };
  imports.wbg.__wbg_parentElement_0e8c9afce5cb9d6e = function(arg02) {
    const ret2 = getObject(arg02).parentElement;
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_appendChild_b8199dc1655c852d = function() {
    return handleError(function(arg02, arg12) {
      const ret2 = getObject(arg02).appendChild(getObject(arg12));
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_target_b629c177f9bee3da = function(arg02) {
    const ret2 = getObject(arg02).target;
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_cancelBubble_c9a8182589205d54 = function(arg02) {
    const ret2 = getObject(arg02).cancelBubble;
    return ret2;
  };
  imports.wbg.__wbg_preventDefault_16b2170b12f56317 = function(arg02) {
    getObject(arg02).preventDefault();
  };
  imports.wbg.__wbg_stopPropagation_7647c9985222f9b0 = function(arg02) {
    getObject(arg02).stopPropagation();
  };
  imports.wbg.__wbg_getGamepads_4c461e89e0e20e75 = function() {
    return handleError(function(arg02) {
      const ret2 = getObject(arg02).getGamepads();
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_id_291975ef0fb03ce5 = function(arg02, arg12) {
    const ret2 = getObject(arg12).id;
    const ptr0 = passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_index_648379aa28ee0be3 = function(arg02) {
    const ret2 = getObject(arg02).index;
    return ret2;
  };
  imports.wbg.__wbg_mapping_6ef03dc7a02c4bef = function(arg02) {
    const ret2 = getObject(arg02).mapping;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_connected_149a005d845e67e2 = function(arg02) {
    const ret2 = getObject(arg02).connected;
    return ret2;
  };
  imports.wbg.__wbg_buttons_e33d9bb4a83e0700 = function(arg02) {
    const ret2 = getObject(arg02).buttons;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_axes_81f7594079c3e88c = function(arg02) {
    const ret2 = getObject(arg02).axes;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_matches_7b5ad9e6bb56f1f3 = function(arg02) {
    const ret2 = getObject(arg02).matches;
    return ret2;
  };
  imports.wbg.__wbg_addListener_dfc3f9e430149b14 = function() {
    return handleError(function(arg02, arg12) {
      getObject(arg02).addListener(getObject(arg12));
    }, arguments);
  };
  imports.wbg.__wbg_removeListener_6f811d2fb59768b9 = function() {
    return handleError(function(arg02, arg12) {
      getObject(arg02).removeListener(getObject(arg12));
    }, arguments);
  };
  imports.wbg.__wbg_size_5ce324b99223d189 = function(arg02) {
    const ret2 = getObject(arg02).size;
    return ret2;
  };
  imports.wbg.__wbg_type_979610383a4b7c57 = function(arg02) {
    const ret2 = getObject(arg02).type;
    return ret2;
  };
  imports.wbg.__wbg_name_1e6651aff4fe7a88 = function(arg02, arg12) {
    const ret2 = getObject(arg12).name;
    const ptr0 = passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_drawArraysInstancedANGLE_403faa11d52ccf6d = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).drawArraysInstancedANGLE(arg12 >>> 0, arg2, arg3, arg4);
  };
  imports.wbg.__wbg_drawElementsInstancedANGLE_0230afc27cf9cec9 = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).drawElementsInstancedANGLE(arg12 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
  };
  imports.wbg.__wbg_vertexAttribDivisorANGLE_6bbb3df4c6e7d08b = function(arg02, arg12, arg2) {
    getObject(arg02).vertexAttribDivisorANGLE(arg12 >>> 0, arg2 >>> 0);
  };
  imports.wbg.__wbg_copyToChannel_9babe9bf308bffc3 = function() {
    return handleError(function(arg02, arg12, arg2, arg3) {
      getObject(arg02).copyToChannel(getArrayF32FromWasm0(arg12, arg2), arg3);
    }, arguments);
  };
  imports.wbg.__wbg_setProperty_21e2e7868b86a93e = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4) {
      getObject(arg02).setProperty(getStringFromWasm0(arg12, arg2), getStringFromWasm0(arg3, arg4));
    }, arguments);
  };
  imports.wbg.__wbg_x_0938e87a3ff14a2e = function(arg02) {
    const ret2 = getObject(arg02).x;
    return ret2;
  };
  imports.wbg.__wbg_y_b881176a43492948 = function(arg02) {
    const ret2 = getObject(arg02).y;
    return ret2;
  };
  imports.wbg.__wbg_width_f0cbf7dcbbe056da = function(arg02) {
    const ret2 = getObject(arg02).width;
    return ret2;
  };
  imports.wbg.__wbg_height_e46975153da440ae = function(arg02) {
    const ret2 = getObject(arg02).height;
    return ret2;
  };
  imports.wbg.__wbg_pressed_3b05e38d48c4c7ab = function(arg02) {
    const ret2 = getObject(arg02).pressed;
    return ret2;
  };
  imports.wbg.__wbg_body_be46234bb33edd63 = function(arg02) {
    const ret2 = getObject(arg02).body;
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_fullscreenElement_65f14a4df7c25129 = function(arg02) {
    const ret2 = getObject(arg02).fullscreenElement;
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createElement_e2a0e21263eb5416 = function() {
    return handleError(function(arg02, arg12, arg2) {
      const ret2 = getObject(arg02).createElement(getStringFromWasm0(arg12, arg2));
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_exitFullscreen_36506b10bd87f8b8 = function(arg02) {
    getObject(arg02).exitFullscreen();
  };
  imports.wbg.__wbg_exitPointerLock_c255b2b7e186916c = function(arg02) {
    getObject(arg02).exitPointerLock();
  };
  imports.wbg.__wbg_querySelector_32b9d7ebb2df951d = function() {
    return handleError(function(arg02, arg12, arg2) {
      const ret2 = getObject(arg02).querySelector(getStringFromWasm0(arg12, arg2));
      return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_getBoundingClientRect_aaa701cbcb448965 = function(arg02) {
    const ret2 = getObject(arg02).getBoundingClientRect();
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_requestFullscreen_4eee04b9090fa98a = function() {
    return handleError(function(arg02) {
      getObject(arg02).requestFullscreen();
    }, arguments);
  };
  imports.wbg.__wbg_requestPointerLock_810495dd0fa1efc0 = function(arg02) {
    getObject(arg02).requestPointerLock();
  };
  imports.wbg.__wbg_setAttribute_79c9562d32d05e66 = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4) {
      getObject(arg02).setAttribute(getStringFromWasm0(arg12, arg2), getStringFromWasm0(arg3, arg4));
    }, arguments);
  };
  imports.wbg.__wbg_setPointerCapture_5479dc0d082282b7 = function() {
    return handleError(function(arg02, arg12) {
      getObject(arg02).setPointerCapture(arg12);
    }, arguments);
  };
  imports.wbg.__wbg_style_2141664e428fef46 = function(arg02) {
    const ret2 = getObject(arg02).style;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_bufferData_05664df801d7aec0 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).bufferData(arg12 >>> 0, arg2, arg3 >>> 0);
  };
  imports.wbg.__wbg_bufferData_023700b2ed207c43 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).bufferData(arg12 >>> 0, getObject(arg2), arg3 >>> 0);
  };
  imports.wbg.__wbg_bufferSubData_4e653f611d7a962d = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).bufferSubData(arg12 >>> 0, arg2, getObject(arg3));
  };
  imports.wbg.__wbg_compressedTexSubImage2D_788296e97b316838 = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
    getObject(arg02).compressedTexSubImage2D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, getObject(arg8));
  };
  imports.wbg.__wbg_readPixels_30de7174c15126d3 = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7) {
      getObject(arg02).readPixels(arg12, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, getObject(arg7));
    }, arguments);
  };
  imports.wbg.__wbg_texSubImage2D_57792696288b0a61 = function() {
    return handleError(function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
      getObject(arg02).texSubImage2D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, getObject(arg9));
    }, arguments);
  };
  imports.wbg.__wbg_uniform2fv_c29ce786946f1aae = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform2fv(getObject(arg12), getArrayF32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniform2iv_58c3d5ee9e70c71d = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform2iv(getObject(arg12), getArrayI32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniform3fv_5ca48b3279e0c643 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform3fv(getObject(arg12), getArrayF32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniform3iv_0a103fe131bd9213 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform3iv(getObject(arg12), getArrayI32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniform4fv_14f1c5ef10bfb4c9 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform4fv(getObject(arg12), getArrayF32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniform4iv_9436eeda2a27cce8 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).uniform4iv(getObject(arg12), getArrayI32FromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_uniformMatrix2fv_1a40e9f63b2005c8 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).uniformMatrix2fv(getObject(arg12), arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
  };
  imports.wbg.__wbg_uniformMatrix3fv_dcde28ba8c34d30e = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).uniformMatrix3fv(getObject(arg12), arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
  };
  imports.wbg.__wbg_uniformMatrix4fv_4575a018c8188146 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).uniformMatrix4fv(getObject(arg12), arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
  };
  imports.wbg.__wbg_activeTexture_01d5469eb22c10e7 = function(arg02, arg12) {
    getObject(arg02).activeTexture(arg12 >>> 0);
  };
  imports.wbg.__wbg_attachShader_14fb12e2ae589dc3 = function(arg02, arg12, arg2) {
    getObject(arg02).attachShader(getObject(arg12), getObject(arg2));
  };
  imports.wbg.__wbg_bindBuffer_b7c382dcd70e33f6 = function(arg02, arg12, arg2) {
    getObject(arg02).bindBuffer(arg12 >>> 0, getObject(arg2));
  };
  imports.wbg.__wbg_bindFramebuffer_a5ab0ed0463586cb = function(arg02, arg12, arg2) {
    getObject(arg02).bindFramebuffer(arg12 >>> 0, getObject(arg2));
  };
  imports.wbg.__wbg_bindRenderbuffer_2d67c879cdbe5ea9 = function(arg02, arg12, arg2) {
    getObject(arg02).bindRenderbuffer(arg12 >>> 0, getObject(arg2));
  };
  imports.wbg.__wbg_bindTexture_c1c0e00507424f8e = function(arg02, arg12, arg2) {
    getObject(arg02).bindTexture(arg12 >>> 0, getObject(arg2));
  };
  imports.wbg.__wbg_blendColor_13739d87434b79c3 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).blendColor(arg12, arg2, arg3, arg4);
  };
  imports.wbg.__wbg_blendEquation_562c3267161e4675 = function(arg02, arg12) {
    getObject(arg02).blendEquation(arg12 >>> 0);
  };
  imports.wbg.__wbg_blendEquationSeparate_48b95e78f7224be4 = function(arg02, arg12, arg2) {
    getObject(arg02).blendEquationSeparate(arg12 >>> 0, arg2 >>> 0);
  };
  imports.wbg.__wbg_blendFunc_f4365f78b650180f = function(arg02, arg12, arg2) {
    getObject(arg02).blendFunc(arg12 >>> 0, arg2 >>> 0);
  };
  imports.wbg.__wbg_blendFuncSeparate_b508053691b6ebbe = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).blendFuncSeparate(arg12 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
  };
  imports.wbg.__wbg_colorMask_99120a2c8caf1298 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).colorMask(arg12 !== 0, arg2 !== 0, arg3 !== 0, arg4 !== 0);
  };
  imports.wbg.__wbg_compileShader_4e9130ccbd4a0238 = function(arg02, arg12) {
    getObject(arg02).compileShader(getObject(arg12));
  };
  imports.wbg.__wbg_copyTexSubImage2D_7c0b0080eece3c1a = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
    getObject(arg02).copyTexSubImage2D(arg12 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
  };
  imports.wbg.__wbg_createBuffer_8c64250e5283611c = function(arg02) {
    const ret2 = getObject(arg02).createBuffer();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createFramebuffer_1f943a32c748753e = function(arg02) {
    const ret2 = getObject(arg02).createFramebuffer();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createProgram_28db0ff3cee5f71a = function(arg02) {
    const ret2 = getObject(arg02).createProgram();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createRenderbuffer_a76dcfda7bdc749a = function(arg02) {
    const ret2 = getObject(arg02).createRenderbuffer();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createShader_c5fcd8592f47b510 = function(arg02, arg12) {
    const ret2 = getObject(arg02).createShader(arg12 >>> 0);
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_createTexture_81fd93af28301e0e = function(arg02) {
    const ret2 = getObject(arg02).createTexture();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_cullFace_d4450f8718c6b3eb = function(arg02, arg12) {
    getObject(arg02).cullFace(arg12 >>> 0);
  };
  imports.wbg.__wbg_deleteBuffer_17feed38f3a70ec9 = function(arg02, arg12) {
    getObject(arg02).deleteBuffer(getObject(arg12));
  };
  imports.wbg.__wbg_deleteFramebuffer_130abca01c89b7d6 = function(arg02, arg12) {
    getObject(arg02).deleteFramebuffer(getObject(arg12));
  };
  imports.wbg.__wbg_deleteProgram_dd5f0e2bc555e270 = function(arg02, arg12) {
    getObject(arg02).deleteProgram(getObject(arg12));
  };
  imports.wbg.__wbg_deleteRenderbuffer_385f3c9e8759b99e = function(arg02, arg12) {
    getObject(arg02).deleteRenderbuffer(getObject(arg12));
  };
  imports.wbg.__wbg_deleteShader_fac9fb3cdefdf6ec = function(arg02, arg12) {
    getObject(arg02).deleteShader(getObject(arg12));
  };
  imports.wbg.__wbg_deleteTexture_605a36a7e380df5f = function(arg02, arg12) {
    getObject(arg02).deleteTexture(getObject(arg12));
  };
  imports.wbg.__wbg_depthFunc_00d8a905436dc681 = function(arg02, arg12) {
    getObject(arg02).depthFunc(arg12 >>> 0);
  };
  imports.wbg.__wbg_depthMask_134f9e3073ca4fd0 = function(arg02, arg12) {
    getObject(arg02).depthMask(arg12 !== 0);
  };
  imports.wbg.__wbg_depthRange_f34f19edea1feadd = function(arg02, arg12, arg2) {
    getObject(arg02).depthRange(arg12, arg2);
  };
  imports.wbg.__wbg_disable_65425605098b79cf = function(arg02, arg12) {
    getObject(arg02).disable(arg12 >>> 0);
  };
  imports.wbg.__wbg_disableVertexAttribArray_cf25f8beb5872364 = function(arg02, arg12) {
    getObject(arg02).disableVertexAttribArray(arg12 >>> 0);
  };
  imports.wbg.__wbg_drawArrays_e5fa3cfc2b5d7c6d = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).drawArrays(arg12 >>> 0, arg2, arg3);
  };
  imports.wbg.__wbg_drawElements_a388832eba137ef0 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).drawElements(arg12 >>> 0, arg2, arg3 >>> 0, arg4);
  };
  imports.wbg.__wbg_enable_2c3b6a4692af9b1b = function(arg02, arg12) {
    getObject(arg02).enable(arg12 >>> 0);
  };
  imports.wbg.__wbg_enableVertexAttribArray_6dd3d0668209ae19 = function(arg02, arg12) {
    getObject(arg02).enableVertexAttribArray(arg12 >>> 0);
  };
  imports.wbg.__wbg_framebufferRenderbuffer_3bf1420713a0b21a = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).framebufferRenderbuffer(arg12 >>> 0, arg2 >>> 0, arg3 >>> 0, getObject(arg4));
  };
  imports.wbg.__wbg_framebufferTexture2D_ed03c0674b9979ce = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).framebufferTexture2D(arg12 >>> 0, arg2 >>> 0, arg3 >>> 0, getObject(arg4), arg5);
  };
  imports.wbg.__wbg_frontFace_00177185d2fae697 = function(arg02, arg12) {
    getObject(arg02).frontFace(arg12 >>> 0);
  };
  imports.wbg.__wbg_getActiveUniform_e49dcda694ae15ab = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).getActiveUniform(getObject(arg12), arg2 >>> 0);
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_getParameter_d6cd2dd2cde656ec = function() {
    return handleError(function(arg02, arg12) {
      const ret2 = getObject(arg02).getParameter(arg12 >>> 0);
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_getProgramInfoLog_7fd2a7c6c1a280c1 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg12).getProgramInfoLog(getObject(arg2));
    var ptr0 = isLikeNone(ret2) ? 0 : passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    var len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_getProgramParameter_af1cfcccbbc80f71 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).getProgramParameter(getObject(arg12), arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_getShaderInfoLog_d057293074e59c61 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg12).getShaderInfoLog(getObject(arg2));
    var ptr0 = isLikeNone(ret2) ? 0 : passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    var len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_getShaderParameter_685d7d7092c6bae6 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).getShaderParameter(getObject(arg12), arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_getUniformLocation_b46e5db76599a918 = function(arg02, arg12, arg2, arg3) {
    const ret2 = getObject(arg02).getUniformLocation(getObject(arg12), getStringFromWasm0(arg2, arg3));
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_linkProgram_ca9df3fba2fd4125 = function(arg02, arg12) {
    getObject(arg02).linkProgram(getObject(arg12));
  };
  imports.wbg.__wbg_pixelStorei_f97b971917582269 = function(arg02, arg12, arg2) {
    getObject(arg02).pixelStorei(arg12 >>> 0, arg2);
  };
  imports.wbg.__wbg_polygonOffset_fb73618b77fd3f6f = function(arg02, arg12, arg2) {
    getObject(arg02).polygonOffset(arg12, arg2);
  };
  imports.wbg.__wbg_renderbufferStorage_37eab84be1494aef = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).renderbufferStorage(arg12 >>> 0, arg2 >>> 0, arg3, arg4);
  };
  imports.wbg.__wbg_scissor_8bc2e761846f53f0 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).scissor(arg12, arg2, arg3, arg4);
  };
  imports.wbg.__wbg_shaderSource_457e8bc42050401d = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).shaderSource(getObject(arg12), getStringFromWasm0(arg2, arg3));
  };
  imports.wbg.__wbg_stencilFuncSeparate_510d3287542b4574 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).stencilFuncSeparate(arg12 >>> 0, arg2 >>> 0, arg3, arg4 >>> 0);
  };
  imports.wbg.__wbg_stencilMask_e1887eeaabe22771 = function(arg02, arg12) {
    getObject(arg02).stencilMask(arg12 >>> 0);
  };
  imports.wbg.__wbg_stencilMaskSeparate_e89abefeb5641657 = function(arg02, arg12, arg2) {
    getObject(arg02).stencilMaskSeparate(arg12 >>> 0, arg2 >>> 0);
  };
  imports.wbg.__wbg_stencilOpSeparate_aa3d09aa448a6f48 = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).stencilOpSeparate(arg12 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
  };
  imports.wbg.__wbg_texParameteri_9fbb09bbf9670af4 = function(arg02, arg12, arg2, arg3) {
    getObject(arg02).texParameteri(arg12 >>> 0, arg2 >>> 0, arg3);
  };
  imports.wbg.__wbg_uniform1f_062c683ec584f7e8 = function(arg02, arg12, arg2) {
    getObject(arg02).uniform1f(getObject(arg12), arg2);
  };
  imports.wbg.__wbg_uniform1i_1f8256271b54cf41 = function(arg02, arg12, arg2) {
    getObject(arg02).uniform1i(getObject(arg12), arg2);
  };
  imports.wbg.__wbg_uniform4f_68fac972655f5359 = function(arg02, arg12, arg2, arg3, arg4, arg5) {
    getObject(arg02).uniform4f(getObject(arg12), arg2, arg3, arg4, arg5);
  };
  imports.wbg.__wbg_useProgram_6c9019d05fb8d280 = function(arg02, arg12) {
    getObject(arg02).useProgram(getObject(arg12));
  };
  imports.wbg.__wbg_vertexAttribPointer_ccabef9be68fe1c4 = function(arg02, arg12, arg2, arg3, arg4, arg5, arg6) {
    getObject(arg02).vertexAttribPointer(arg12 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
  };
  imports.wbg.__wbg_viewport_4bdfc4b8959593ee = function(arg02, arg12, arg2, arg3, arg4) {
    getObject(arg02).viewport(arg12, arg2, arg3, arg4);
  };
  imports.wbg.__wbg_error_2d344a50ccf38b3b = function(arg02, arg12) {
    console.error(getObject(arg02), getObject(arg12));
  };
  imports.wbg.__wbg_instanceof_DomException_0dd0987418c574eb = function(arg02) {
    let result;
    try {
      result = getObject(arg02) instanceof DOMException;
    } catch {
      result = false;
    }
    const ret2 = result;
    return ret2;
  };
  imports.wbg.__wbg_message_f15effc8b20828e2 = function(arg02, arg12) {
    const ret2 = getObject(arg12).message;
    const ptr0 = passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_clientX_35f23f953e04ec0e = function(arg02) {
    const ret2 = getObject(arg02).clientX;
    return ret2;
  };
  imports.wbg.__wbg_clientY_8104e462abc0b3ec = function(arg02) {
    const ret2 = getObject(arg02).clientY;
    return ret2;
  };
  imports.wbg.__wbg_offsetX_413d9f02022e72ad = function(arg02) {
    const ret2 = getObject(arg02).offsetX;
    return ret2;
  };
  imports.wbg.__wbg_offsetY_488f80a0a9666028 = function(arg02) {
    const ret2 = getObject(arg02).offsetY;
    return ret2;
  };
  imports.wbg.__wbg_ctrlKey_e1b8f1de1eb24d5d = function(arg02) {
    const ret2 = getObject(arg02).ctrlKey;
    return ret2;
  };
  imports.wbg.__wbg_shiftKey_fdd99b6df96e25c5 = function(arg02) {
    const ret2 = getObject(arg02).shiftKey;
    return ret2;
  };
  imports.wbg.__wbg_altKey_d531a4d3704557cb = function(arg02) {
    const ret2 = getObject(arg02).altKey;
    return ret2;
  };
  imports.wbg.__wbg_metaKey_934772989e28020c = function(arg02) {
    const ret2 = getObject(arg02).metaKey;
    return ret2;
  };
  imports.wbg.__wbg_button_a1c470d5e4c997f2 = function(arg02) {
    const ret2 = getObject(arg02).button;
    return ret2;
  };
  imports.wbg.__wbg_buttons_42a7b7de33d8e572 = function(arg02) {
    const ret2 = getObject(arg02).buttons;
    return ret2;
  };
  imports.wbg.__wbg_movementX_f4d07f6658c1e16f = function(arg02) {
    const ret2 = getObject(arg02).movementX;
    return ret2;
  };
  imports.wbg.__wbg_movementY_30276c1f90aec4fa = function(arg02) {
    const ret2 = getObject(arg02).movementY;
    return ret2;
  };
  imports.wbg.__wbg_pointerId_d2caae4465ba386f = function(arg02) {
    const ret2 = getObject(arg02).pointerId;
    return ret2;
  };
  imports.wbg.__wbg_deltaX_b7d127c94d6265c0 = function(arg02) {
    const ret2 = getObject(arg02).deltaX;
    return ret2;
  };
  imports.wbg.__wbg_deltaY_b32fa858e16edcc0 = function(arg02) {
    const ret2 = getObject(arg02).deltaY;
    return ret2;
  };
  imports.wbg.__wbg_deltaMode_11f7b19e64d9a515 = function(arg02) {
    const ret2 = getObject(arg02).deltaMode;
    return ret2;
  };
  imports.wbg.__wbg_destination_5dfc354bcf2eb941 = function(arg02) {
    const ret2 = getObject(arg02).destination;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_currentTime_d94729a1b5fd59a5 = function(arg02) {
    const ret2 = getObject(arg02).currentTime;
    return ret2;
  };
  imports.wbg.__wbg_newwithcontextoptions_6c6a79a71ed7efa3 = function() {
    return handleError(function(arg02) {
      const ret2 = new lAudioContext(getObject(arg02));
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_close_82409a9d656a7c26 = function() {
    return handleError(function(arg02) {
      const ret2 = getObject(arg02).close();
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_createBuffer_d142e00390bff447 = function() {
    return handleError(function(arg02, arg12, arg2, arg3) {
      const ret2 = getObject(arg02).createBuffer(arg12 >>> 0, arg2 >>> 0, arg3);
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_createBufferSource_1473226efd418a08 = function() {
    return handleError(function(arg02) {
      const ret2 = getObject(arg02).createBufferSource();
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_resume_72fe7cd3e68b861a = function() {
    return handleError(function(arg02) {
      const ret2 = getObject(arg02).resume();
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_bindVertexArrayOES_688eba003a98a0bb = function(arg02, arg12) {
    getObject(arg02).bindVertexArrayOES(getObject(arg12));
  };
  imports.wbg.__wbg_createVertexArrayOES_02cfe655604046eb = function(arg02) {
    const ret2 = getObject(arg02).createVertexArrayOES();
    return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
  };
  imports.wbg.__wbg_deleteVertexArrayOES_ba22911f739464a7 = function(arg02, arg12) {
    getObject(arg02).deleteVertexArrayOES(getObject(arg12));
  };
  imports.wbg.__wbg_now_c644db5194be8437 = function(arg02) {
    const ret2 = getObject(arg02).now();
    return ret2;
  };
  imports.wbg.__wbg_instanceof_Response_fb3a4df648c1859b = function(arg02) {
    let result;
    try {
      result = getObject(arg02) instanceof Response;
    } catch {
      result = false;
    }
    const ret2 = result;
    return ret2;
  };
  imports.wbg.__wbg_arrayBuffer_cb886e06a9e36e4d = function() {
    return handleError(function(arg02) {
      const ret2 = getObject(arg02).arrayBuffer();
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_instanceof_HtmlCanvasElement_f5f69dab93281ebe = function(arg02) {
    let result;
    try {
      result = getObject(arg02) instanceof HTMLCanvasElement;
    } catch {
      result = false;
    }
    const ret2 = result;
    return ret2;
  };
  imports.wbg.__wbg_width_a40e21a22129b197 = function(arg02) {
    const ret2 = getObject(arg02).width;
    return ret2;
  };
  imports.wbg.__wbg_setwidth_81c62bc806e0a727 = function(arg02, arg12) {
    getObject(arg02).width = arg12 >>> 0;
  };
  imports.wbg.__wbg_height_98d51321254345a5 = function(arg02) {
    const ret2 = getObject(arg02).height;
    return ret2;
  };
  imports.wbg.__wbg_setheight_98cf0db22c40ef07 = function(arg02, arg12) {
    getObject(arg02).height = arg12 >>> 0;
  };
  imports.wbg.__wbg_getContext_89a318b610dc5fd4 = function() {
    return handleError(function(arg02, arg12, arg2, arg3) {
      const ret2 = getObject(arg02).getContext(getStringFromWasm0(arg12, arg2), getObject(arg3));
      return isLikeNone(ret2) ? 0 : addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_matches_46e979ff3e4d0811 = function(arg02) {
    const ret2 = getObject(arg02).matches;
    return ret2;
  };
  imports.wbg.__wbg_drawBuffersWEBGL_dfb0d803ea7ebe07 = function(arg02, arg12) {
    getObject(arg02).drawBuffersWEBGL(getObject(arg12));
  };
  imports.wbg.__wbg_get_27fe3dac1c4d0224 = function(arg02, arg12) {
    const ret2 = getObject(arg02)[arg12 >>> 0];
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_length_e498fbc24f9c1d4f = function(arg02) {
    const ret2 = getObject(arg02).length;
    return ret2;
  };
  imports.wbg.__wbg_new_b525de17f44a8943 = function() {
    const ret2 = new Array();
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_newnoargs_2b8b6bd7753c76ba = function(arg02, arg12) {
    const ret2 = new Function(getStringFromWasm0(arg02, arg12));
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_get_baf4855f9a986186 = function() {
    return handleError(function(arg02, arg12) {
      const ret2 = Reflect.get(getObject(arg02), getObject(arg12));
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_call_95d1ea488d03e4e8 = function() {
    return handleError(function(arg02, arg12) {
      const ret2 = getObject(arg02).call(getObject(arg12));
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_new_f9876326328f45ed = function() {
    const ret2 = new Object();
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_self_e7c1f827057f6584 = function() {
    return handleError(function() {
      const ret2 = self.self;
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_window_a09ec664e14b1b81 = function() {
    return handleError(function() {
      const ret2 = window.window;
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_globalThis_87cbb8506fecf3a9 = function() {
    return handleError(function() {
      const ret2 = globalThis.globalThis;
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_global_c85a9259e621f3db = function() {
    return handleError(function() {
      const ret2 = global.global;
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbindgen_is_undefined = function(arg02) {
    const ret2 = getObject(arg02) === void 0;
    return ret2;
  };
  imports.wbg.__wbg_eval_be0434aab6074e1e = function() {
    return handleError(function(arg0, arg1) {
      const ret = eval(getStringFromWasm0(arg0, arg1));
      return addHeapObject(ret);
    }, arguments);
  };
  imports.wbg.__wbg_of_892d7838f8e4cc20 = function(arg02) {
    const ret2 = Array.of(getObject(arg02));
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_push_49c286f04dd3bf59 = function(arg02, arg12) {
    const ret2 = getObject(arg02).push(getObject(arg12));
    return ret2;
  };
  imports.wbg.__wbg_call_9495de66fdbe016b = function() {
    return handleError(function(arg02, arg12, arg2) {
      const ret2 = getObject(arg02).call(getObject(arg12), getObject(arg2));
      return addHeapObject(ret2);
    }, arguments);
  };
  imports.wbg.__wbg_now_931686b195a14f9d = function() {
    const ret2 = Date.now();
    return ret2;
  };
  imports.wbg.__wbg_is_8f1618fe9a4fd388 = function(arg02, arg12) {
    const ret2 = Object.is(getObject(arg02), getObject(arg12));
    return ret2;
  };
  imports.wbg.__wbg_resolve_fd40f858d9db1a04 = function(arg02) {
    const ret2 = Promise.resolve(getObject(arg02));
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_then_ec5db6d509eb475f = function(arg02, arg12) {
    const ret2 = getObject(arg02).then(getObject(arg12));
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_then_f753623316e2873a = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).then(getObject(arg12), getObject(arg2));
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_buffer_cf65c07de34b9a08 = function(arg02) {
    const ret2 = getObject(arg02).buffer;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_newwithbyteoffsetandlength_55f9ffb569d9fa74 = function(arg02, arg12, arg2) {
    const ret2 = new Int8Array(getObject(arg02), arg12 >>> 0, arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_newwithbyteoffsetandlength_f477e654086cbbb6 = function(arg02, arg12, arg2) {
    const ret2 = new Int16Array(getObject(arg02), arg12 >>> 0, arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_newwithbyteoffsetandlength_b57a602974d4b1cd = function(arg02, arg12, arg2) {
    const ret2 = new Int32Array(getObject(arg02), arg12 >>> 0, arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_newwithbyteoffsetandlength_9fb2f11355ecadf5 = function(arg02, arg12, arg2) {
    const ret2 = new Uint8Array(getObject(arg02), arg12 >>> 0, arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_new_537b7341ce90bb31 = function(arg02) {
    const ret2 = new Uint8Array(getObject(arg02));
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_set_17499e8aa4003ebd = function(arg02, arg12, arg2) {
    getObject(arg02).set(getObject(arg12), arg2 >>> 0);
  };
  imports.wbg.__wbg_length_27a2afe8ab42b09f = function(arg02) {
    const ret2 = getObject(arg02).length;
    return ret2;
  };
  imports.wbg.__wbg_newwithbyteoffsetandlength_9241d9d251418ebf = function(arg02, arg12, arg2) {
    const ret2 = new Uint16Array(getObject(arg02), arg12 >>> 0, arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_newwithbyteoffsetandlength_5c5a6e21987c3bee = function(arg02, arg12, arg2) {
    const ret2 = new Uint32Array(getObject(arg02), arg12 >>> 0, arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_newwithbyteoffsetandlength_4078d56428eb2926 = function(arg02, arg12, arg2) {
    const ret2 = new Float32Array(getObject(arg02), arg12 >>> 0, arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_newwithlength_b56c882b57805732 = function(arg02) {
    const ret2 = new Uint8Array(arg02 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_subarray_7526649b91a252a6 = function(arg02, arg12, arg2) {
    const ret2 = getObject(arg02).subarray(arg12 >>> 0, arg2 >>> 0);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbg_set_6aa458a4ebdb65cb = function() {
    return handleError(function(arg02, arg12, arg2) {
      const ret2 = Reflect.set(getObject(arg02), getObject(arg12), getObject(arg2));
      return ret2;
    }, arguments);
  };
  imports.wbg.__wbg_random_afb3265527cf67c8 = typeof Math.random == "function" ? Math.random : notDefined("Math.random");
  imports.wbg.__wbindgen_debug_string = function(arg02, arg12) {
    const ret2 = debugString(getObject(arg12));
    const ptr0 = passStringToWasm0(ret2, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_malloc, tangle._time_machine._wasm_instance.instance.exports.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg02 / 4 + 1] = len0;
    getInt32Memory0()[arg02 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbindgen_throw = function(arg02, arg12) {
    throw new Error(getStringFromWasm0(arg02, arg12));
  };
  imports.wbg.__wbindgen_memory = function() {
    const ret2 = tangle._time_machine._wasm_instance.instance.exports.memory;
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper1035 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 372, __wbg_adapter_34);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper1037 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 372, __wbg_adapter_37);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper1039 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 372, __wbg_adapter_37);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper1041 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 372, __wbg_adapter_37);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper1043 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 372, __wbg_adapter_37);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper1045 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 372, __wbg_adapter_37);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper1047 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 372, __wbg_adapter_37);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper1049 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 372, __wbg_adapter_37);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper1051 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 372, __wbg_adapter_37);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper16604 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 10429, __wbg_adapter_54);
    return addHeapObject(ret2);
  };
  imports.wbg.__wbindgen_closure_wrapper39367 = function(arg02, arg12, arg2) {
    const ret2 = makeMutClosure(arg02, arg12, 25326, __wbg_adapter_57);
    return addHeapObject(ret2);
  };
  return imports;
}
function initMemory(imports2, maybe_memory) {
}
function finalizeInit(instance, tangleInstance) {
  tangle = tangleInstance;
  init.__wbindgen_wasm_module = tangle._time_machine._wasm_instance;
  cachedFloat32Memory0 = null;
  cachedFloat64Memory0 = null;
  cachedInt32Memory0 = null;
  cachedUint32Memory0 = null;
  cachedUint8Memory0 = null;
  tangle._time_machine._wasm_instance.instance.exports.__wbindgen_start();
  return wasm;
}
function initSync(module2) {
  const imports2 = getImports();
  initMemory(imports2);
  if (!(module2 instanceof WebAssembly.Module)) {
    module2 = new WebAssembly.Module(module2);
  }
  const instance = new WebAssembly.Instance(module2, imports2);
  return finalizeInit(instance, tangle);
}
async function init(input) {
  if (typeof input === "undefined") {
    input = new URL("tangleshoot_bg.wasm", import.meta.url);
  }
  const imports2 = getImports();
  if (typeof input === "string" || typeof Request === "function" && input instanceof Request || typeof URL === "function" && input instanceof URL) {
    input = fetch(input);
  }
  initMemory(imports2);
  const { instance, tangle: tangle2 } = await load(await input, imports2);
  return finalizeInit(instance, tangle2);
}
var tangleshoot_default = init;

// random-name.ts
function set_random_name() {
  if (!window.location.hash) {
    window.location.hash += ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    window.location.hash += ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    window.location.hash += ANIMAL_NAMES[Math.floor(Math.random() * ANIMAL_NAMES.length)];
  }
}
var ANIMAL_NAMES = [
  "Albatross",
  "Alligator",
  "Alpaca",
  "Antelope",
  "Donkey",
  "Badger",
  "Bat",
  "Bear",
  "Bee",
  "Bison",
  "Buffalo",
  "Butterfly",
  "Camel",
  "Capybara",
  "Cat",
  "Cheetah",
  "Chicken",
  "Chinchilla",
  "Clam",
  "Cobra",
  "Crab",
  "Crane",
  "Crow",
  "Deer",
  "Dog",
  "Dolphin",
  "Dove",
  "Dragonfly",
  "Duck",
  "Eagle",
  "Elephant",
  "Elk",
  "Emu",
  "Falcon",
  "Ferret",
  "Finch",
  "Fish",
  "Flamingo",
  "Fox",
  "Frog",
  "Gazelle",
  "Gerbil",
  "Giraffe",
  "Goat",
  "Goldfish",
  "Goose",
  "Grasshopper",
  "Hamster",
  "Heron",
  "Horse",
  "Hyena",
  "Jaguar",
  "Jellyfish",
  "Kangaroo",
  "Koala",
  "Lemur",
  "Lion",
  "Lobster",
  "Manatee",
  "Mantis",
  "Meerkat",
  "Mongoose",
  "Moose",
  "Mouse",
  "Narwhal",
  "Octopus",
  "Okapi",
  "Otter",
  "Owl",
  "Panther",
  "Parrot",
  "Pelican",
  "Penguin",
  "Pony",
  "Porcupine",
  "Rabbit",
  "Raccoon",
  "Raven",
  "Salmon",
  "Seahorse",
  "Seal",
  "Shark",
  "Snake",
  "Sparrow",
  "Stingray",
  "Stork",
  "Swan",
  "Tiger",
  "Turtle",
  "Viper",
  "Walrus",
  "Wolf",
  "Wolverine",
  "Wombat",
  "Yak",
  "Zebra",
  "Gnome",
  "Unicorn",
  "Dragon",
  "Hippo"
];
var ADJECTIVES = [
  "Beefy",
  "Big",
  "Bold",
  "Brave",
  "Bright",
  "Buff",
  "Calm",
  "Charming",
  "Chill",
  "Creative",
  "Cute",
  "Cool",
  "Crafty",
  "Cunning",
  "Daring",
  "Elegant",
  "Excellent",
  "Fab",
  "Fluffy",
  "Grand",
  "Green",
  "Happy",
  "Heavy",
  "Honest",
  "Huge",
  "Humble",
  "Iconic",
  "Immense",
  "Jolly",
  "Jumbo",
  "Kind",
  "Little",
  "Loyal",
  "Lucky",
  "Majestic",
  "Noble",
  "Nefarious",
  "Odd",
  "Ornate",
  "Plucky",
  "Plump",
  "Polite",
  "Posh",
  "Quirky",
  "Quick",
  "Round",
  "Relaxed",
  "Rotund",
  "Shy",
  "Sleek",
  "Sly",
  "Spry",
  "Stellar",
  "Super",
  "Tactical",
  "Tidy",
  "Trendy",
  "Unique",
  "Vivid",
  "Wild",
  "Yappy",
  "Young",
  "Zany",
  "Zesty"
];

// index.ts
async function main() {
  set_random_name();
  const rs = await tangleshoot_default();
  const m = rs.main;
  m();
}
main();
//# sourceMappingURL=index.js.map
