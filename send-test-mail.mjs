// Test send via Beagle Mail /send, to Wei's Gmail, per Wei's order (main chat 01:32 PST).
import { readFileSync } from "node:fs";
import nacl from "tweetnacl";
import { base58ToBytes } from "@decentnetwork/peer/dist/utils/base58.js";

const kp = JSON.parse(readFileSync("/home/hatch/.agentnet/carrier/keypair.json", "utf8"));
const sk = Uint8Array.from(Buffer.from(kp.secretKey, "hex"));
if (sk.length !== 32) throw new Error("unexpected secret key length " + sk.length);

const msg = {
  name: "noor",
  ts: Date.now(),
  to: "weili.walk@gmail.com",
  subject: "Test from Noor — Beagle Mail send path",
  text: "Hi Wei — this is Noor, testing the new outbound Beagle Mail send path (From noor@mail.beagle.chat, Reply-To noor@beagle.chat). You asked me to send this test before the GitHub reply goes out. Please confirm it arrived, and whether it landed in your inbox or spam. — Noor",
};

const nonce = nacl.randomBytes(24);
const box = nacl.box(
  new TextEncoder().encode(JSON.stringify(msg)),
  nonce,
  base58ToBytes("6xddTquF89cf6t2TEKddHAyvR88xboc5AGhZFpj6HVC3"),
  sk
);
const b64 = (u) => Buffer.from(u).toString("base64");
const r = await fetch("https://beagle-mail.beaglechat.workers.dev/send", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ userid: "CoHMW66WT5Qwuuyxpun3urBKkCry8SgDCDkpsJorTGuu", nonce: b64(nonce), box: b64(box) }),
});
console.log("HTTP", r.status);
console.log(await r.text());
