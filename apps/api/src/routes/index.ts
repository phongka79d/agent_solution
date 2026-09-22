import type { FastifyInstance } from 'fastify';

import { registerCampaignRoutes } from './v1/campaigns.js';
import { registerChatRoutes } from './v1/chat.js';
import { registerEventRoutes } from './v1/events.js';
import { registerWebhookRoutes } from './v1/webhooks.js';

/**
 * Registers the `/api/v1` route groups. Every group is a P0 placeholder and
 * registers no route: the gateway's only live route is `/health`.
 */
export function registerRoutes(app: FastifyInstance): void {
  registerChatRoutes(app);
  registerEventRoutes(app);
  registerCampaignRoutes(app);
  registerWebhookRoutes(app);
}
