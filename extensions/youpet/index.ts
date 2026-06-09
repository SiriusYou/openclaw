import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createYouPetOutboxConsumerSettingsFromConfig,
  isYouPetOutboxConsumerConfigured,
  YouPetOutboxConsumer,
} from "./src/outbox-consumer.js";

const plugin = definePluginEntry({
  id: "youpet",
  name: "YouPet Core",
  description: "Consumes YouPet Core outbox deliveries for orchestration actions.",
  register(api: OpenClawPluginApi) {
    let consumer: YouPetOutboxConsumer | undefined;

    api.registerService({
      id: "youpet-outbox-consumer",
      start(ctx) {
        const settings = createYouPetOutboxConsumerSettingsFromConfig({
          pluginConfig: api.pluginConfig,
          env: process.env,
        });
        if (!settings.enabled) {
          return;
        }
        if (!isYouPetOutboxConsumerConfigured(settings)) {
          ctx.logger.warn(
            "[youpet] Outbox consumer enabled but missing coreBaseUrl or serviceToken",
          );
          return;
        }

        consumer = new YouPetOutboxConsumer({
          ...settings,
          logger: ctx.logger,
        });
        consumer.startPolling();
        ctx.logger.info("[youpet] Started YouPet Core outbox consumer");
      },
      stop() {
        if (!consumer) {
          return;
        }
        consumer.stopPolling();
        consumer = undefined;
      },
    });
  },
});

export default plugin;
export * from "./api.js";
