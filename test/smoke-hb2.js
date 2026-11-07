// Smoke test for Homebridge 2 / HAP-NodeJS 1.x+ compatibility.
//
// Builds light and outlet accessories against fake Tuya devices using the real
// HAP library (with api.hap frozen, as Homebridge 2.5 does), then reads and writes
// every characteristic the way the Home app would. Prints HAP warnings and errors.
//
//   npm install --no-save @homebridge/hap-nodejs@2.3.0
//   node test/smoke-hb2.js

const EventEmitter = require("events");
const path = require("path");
const hap = Object.freeze({...require("@homebridge/hap-nodejs")});

const problems = [];
const origWarn = console.warn, origLog = console.log, origError = console.error;
const capture = (orig) => (...args) => {
  const line = args.map(String).join(" ");
  if (/WARNING|Error|illegal|invalid/i.test(line)) problems.push(line.split("\n")[0]);
  else if (process.env.VERBOSE) orig(...args);
};
console.warn = capture(origWarn);
console.error = capture(origError);
console.log = capture(origLog);

let Platform;
require(path.join(__dirname, "..", "index.js"))({
  platformAccessory: class {},
  hap,
  registerPlatform: (_name, _platform, cls) => { Platform = cls; }
});

const log = Object.assign(() => {}, {info() {}, warn() {}, error: (...a) => problems.push(a.join(" ")), debug() {}});
const api = {hap, on() {}, registerPlatformAccessories() {}};
let platform;
try {
  platform = new Platform(log, {platform: "TuyaLan", devices: []}, api);
} catch (e) {
  origLog(`FAIL platform startup: ${e.message}`);
  process.exit(1);
}

class FakeDevice extends EventEmitter {
  constructor(context, state) {
    super();
    this.context = {version: "3.3", ...context};
    this.state = {...state};
    this.connected = true;
    this.updates = [];
  }
  _connect() { setImmediate(() => { this.emit("connect"); this.emit("change", this.state, this.state); }); }
  update(dps) { this.updates.push(dps); Object.assign(this.state, dps); setImmediate(() => this.emit("change", dps, this.state)); return true; }
}

const CASES = [
  ["simplelight", {}, {1: true}],
  ["simpledimmer", {}, {1: true, 2: 128}],
  ["twlight", {}, {1: true, 2: 128, 3: 128}],
  ["rgbtwlight", {}, {1: true, 2: "white", 3: 255, 4: 128, 5: "ffffff0000ffff"}],
  ["rgbtwlight", {name: "rgbtw-hsb", colorFunction: "HSB", dpPower: 20, dpMode: 21, dpBrightness: 22, dpColorTemperature: 23, dpColor: 24, scaleBrightness: 1000, scaleWhiteColor: 1000},
    {20: true, 21: "colour", 22: 1000, 23: 500, 24: "000003e803e8"}],
  ["outlet", {voltsId: 20, ampsId: 18, wattsId: 19}, {1: true, 18: 120, 19: 140, 20: 1200}],
  ["rgbtwoutlet", {voltsId: 20, ampsId: 18, wattsId: 19}, {1: true, 2: "white", 3: 255, 4: 128, 5: "ffffff0000ffff", 18: 120, 19: 140, 20: 1200}]
];

function sampleValue(c) {
  const p = c.props;
  if (p.validValues && p.validValues.length) return p.validValues[p.validValues.length - 1];
  if (p.format === hap.Formats.BOOL) return !c.value;
  if (typeof p.minValue === "number" && typeof p.maxValue === "number") return Math.round((p.minValue + p.maxValue) / 2);
  return c.value;
}

(async () => {
  const CLASS_DEF = require(path.join(__dirname, "..", "index.js")).CLASS_DEF;
  for (const [type, ctx, state] of CASES) {
    const before = problems.length;
    const name = ctx.name || type;
    const Cls = CLASS_DEF ? CLASS_DEF[type] : require(path.join(__dirname, "..", "lib", {
      simplelight: "SimpleLightAccessory", simpledimmer: "SimpleDimmerAccessory", twlight: "TWLightAccessory",
      rgbtwlight: "RGBTWLightAccessory", outlet: "OutletAccessory", rgbtwoutlet: "RGBTWOutletAccessory"
    }[type]));
    const device = new FakeDevice({name, type, ...ctx}, state);
    const accessory = new hap.Accessory(name, hap.uuid.generate(name));
    // Homebridge's PlatformAccessory adds this helper on top of the HAP accessory
    accessory.getServiceByUUIDAndSubType = (s, sub) => accessory.getServiceById(s, sub);
    let summary = [];
    try {
      new Cls(platform, accessory, device, true);
      await new Promise((r) => setTimeout(r, 50));
      for (const service of accessory.services) {
        if (service.UUID === hap.Service.AccessoryInformation.UUID) continue;
        for (const c of service.characteristics) {
          if (c.props.perms.includes(hap.Perms.PAIRED_READ)) {
            try { await c.handleGetRequest(); } catch (e) { problems.push(`${name} get ${c.displayName}: ${e.message || e}`); }
          }
          if (c.props.perms.includes(hap.Perms.PAIRED_WRITE)) {
            try { await c.handleSetRequest(sampleValue(c)); } catch (e) { problems.push(`${name} set ${c.displayName}: ${e.message || e}`); }
          }
        }
        summary.push(`${service.displayName}[${service.characteristics.map((c) => c.displayName).join(", ")}]`);
      }
      await new Promise((r) => setTimeout(r, 50));
    } catch (e) {
      problems.push(`${name} construct: ${e.stack.split("\n").slice(0, 2).join(" ")}`);
    }
    origLog(`${problems.length === before ? "ok  " : "FAIL"} ${name}: ${summary.join(" ")} | ${device.updates.length} device writes`);
    for (const p of problems.slice(before)) origLog(`       ${p}`);
  }
  process.exitCode = problems.length ? 1 : 0;
})();
