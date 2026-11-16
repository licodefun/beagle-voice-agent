// One-shot: send the approved GitHub Support reply (ticket #4985350) via the
// Beagle Mail send endpoint, per HQ's instructions (nacl.box to Beagle Mail).
import { readFileSync } from "node:fs";
import nacl from "tweetnacl";
import { base58ToBytes } from "@decentnetwork/peer/dist/utils/base58.js";

const kp = JSON.parse(readFileSync("/home/hatch/.agentnet/carrier/keypair.json", "utf8"));
const sk = Uint8Array.from(Buffer.from(kp.secretKey, "hex")); // 32-byte X25519 secret
if (sk.length !== 32) throw new Error("unexpected secret key length " + sk.length);

const hdr = JSON.parse(readFileSync("/home/hatch/workspace/beagle-mail-bridge/sent/gh-headers.json", "utf8"));
const text = readFileSync("/home/hatch/workspace/beagle-mail-bridge/sent/gh-reply-body.txt", "utf8").replace(/\n$/, "");

const msg = {
  name: "noor",
  ts: Date.now(),
  to: "developer@githubsupport.com",
  subject: "Re: " + hdr.subject,
  text,
  inReplyTo: hdr.messageId,
  references: hdr.messageId,
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
