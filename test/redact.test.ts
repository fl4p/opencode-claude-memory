import { describe, expect, test } from "bun:test"
import { redactSecrets, scrubMemoryFields } from "../src/redact.js"

// Ported 1:1 from the Python harness regression suite (test_redact_secrets.py).
// Every "secret" value below is SYNTHETIC — never put a real credential in a repo.
const R = "«REDACTED»"

// [label, input, mustRedact] — true => value gone & count>=1; false => unchanged
const CASES: [string, string, boolean][] = [
  // §18a regression: WiFi PSK family
  ["psk backtick-quoted", "Lab WiFi PSK `swordfish42`", true],
  ["psk copula + shaped", "the PSK is hunter2pls", true],
  ["wpa2-psk quoted", "WPA2-PSK 'Ztr0ng-Pass'", true],
  ["pre-shared key", "pre-shared key: Abc12345", true],
  ["wifi password", "wifi password is Corr3ct-Horse", true],
  ["network key quoted", "network key `n3tw0rkz`", true],
  ["passcode", "passcode = 9981aa", true],
  // existing behaviour must still hold
  ["password copula", "the password is hunter2pickle", true],
  ["api key quoted no copula", "api_key 'sk-AbC123xyz'", true],
  ["token =", "token=ghp_AbCd1234EfGh", true],
  // must NOT redact (false-positive guards)
  ["ssid name (not a secret)", "SSID `home-net-2g` and `guest-net`", false],
  ["location pointer", "the keys live in ~/.config/creds.env", false],
  ["password-protected prose", "the archive is password-protected", false],
  ["wifi is down (no value)", "the wifi is down again today", false],
  ["plain prose w/ 'key'", "the network key concept is important", false],
]

describe("redactSecrets (ported regression suite)", () => {
  for (const [label, text, must] of CASES) {
    test(label, () => {
      const { text: out, count } = redactSecrets(text)
      if (must) {
        expect(count).toBeGreaterThanOrEqual(1)
        expect(out).toContain(R)
      } else {
        expect(count).toBe(0)
        expect(out).toBe(text)
      }
    })
  }

  test("empty input is a no-op", () => {
    expect(redactSecrets("")).toEqual({ text: "", count: 0 })
  })

  test("does not eat a trailing sentence period", () => {
    const { text } = redactSecrets("the password is hunter2pickle.")
    expect(text).toBe("the password is «REDACTED».")
  })

  test("redacts multiple secrets and counts them", () => {
    const { count } = redactSecrets("password is hunter2pls and the api_key 'sk-AbC123xyz'")
    expect(count).toBe(2)
  })
})

describe("scrubMemoryFields", () => {
  test("covers name/description/content and totals the count", () => {
    const s = scrubMemoryFields({
      name: "Lab WiFi",
      description: "PSK `swordfish42`",
      content: "ssid home-net, the password is hunter2pls",
    })
    expect(s.count).toBeGreaterThanOrEqual(2)
    expect(s.description).toContain(R)
    expect(s.content).toContain(R)
    expect(s.name).toBe("Lab WiFi") // no secret in name → untouched
  })

  test("clean fields are returned unchanged with count 0", () => {
    const s = scrubMemoryFields({ name: "Style", description: "formatting", content: "use semicolons" })
    expect(s).toEqual({ name: "Style", description: "formatting", content: "use semicolons", count: 0 })
  })
})
