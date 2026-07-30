import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCoreOutboxEvent } from "../test/outbox-consumer.fixture.js";
import {
  YouPetOutboxConsumer,
  type YouPetOutboxDeliveryEnvelope,
  type YouPetOutboxEventEnvelope,
  type YouPetOutboxFetch,
} from "./outbox-consumer.js";

type VendoredFixture = {
  items: [YouPetOutboxDeliveryEnvelope];
  provenance: {
    canonical_source: string;
    canonical_sha256: string;
    fixture_name: string;
  };
};

const VENDORED_TASK_MISSED_FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/youpet-core-task-missed-outbox.json", import.meta.url), "utf8"),
) as VendoredFixture;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("YouPet Core outbox fixture drift", () => {
  it("normalizes the OpenClaw fake to the vendored Core task.missed envelope", async () => {
    expect(VENDORED_TASK_MISSED_FIXTURE.provenance).toEqual({
      canonical_source: "youpet-core/tests/fixtures/core_outbox_task_missed.json",
      canonical_sha256: "d264d9a8eb5001855b1cc2d19b6b64d582c9e9899a633d25e0d7d10afd348ff1",
      fixture_name: "task.missed openclaw envelope",
    });

    const expected = VENDORED_TASK_MISSED_FIXTURE.items[0];
    const businessPayload = expected.payload.payload as Record<string, unknown>;
    const emitted = createCoreOutboxEvent(expected.event_type, businessPayload);
    let normalized: YouPetOutboxEventEnvelope | undefined;
    const fetchFn: YouPetOutboxFetch = async (input) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const pathname = new URL(url).pathname;
      if (pathname === "/internal/events/outbox") {
        return jsonResponse({ items: [emitted] });
      }
      if (pathname.endsWith("/ack")) {
        return jsonResponse({
          event_id: expected.event_id,
          consumer: "openclaw",
          state: "delivered",
          attempts: 0,
          next_attempt_at: "2026-06-01T00:00:00Z",
        });
      }
      if (pathname.endsWith("/nack")) {
        return jsonResponse({
          event_id: expected.event_id,
          consumer: "openclaw",
          state: "pending",
          attempts: 1,
          next_attempt_at: "2026-06-01T00:05:00Z",
        });
      }
      return jsonResponse({ detail: { code: "not_found", message: pathname } }, 404);
    };

    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
      handlers: {
        "task.missed": (event) => {
          normalized = event;
        },
      },
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(normalized).toEqual({
      ...expected,
      delivery_id: expected.event_id,
      event_id:
        typeof expected.payload.event_id === "string"
          ? expected.payload.event_id
          : expected.event_id,
    });
  });
});
